import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PKG = 'F:\\AgentWorkProject\\TS0 杂务\\plugins\\dsh-readonly-mode';
const pkgUrl = (file) => pathToFileURL(path.join(PKG, file)).href;

let failures = 0;
const check = (label, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

/* ---------------- host half ---------------- */
const host = await import(pkgUrl('index.js'));

const guards = [];
const commands = [];
const effects = [];
let rpcHandler;
let rpcChannel;

const hostScope = {
  root: {
    connection: {
      rpc: {
        handle(channel, handler) {
          rpcChannel = channel;
          rpcHandler = handler;
          return () => {};
        },
      },
    },
  },
  commands: {
    register(def) {
      commands.push(def);
      return () => {};
    },
  },
  effect(fn) {
    const disposer = fn();
    effects.push(disposer);
    return disposer;
  },
};

const hostCtx = {
  tools: {
    guard(fn) {
      guards.push(fn);
      return () => {};
    },
  },
  effect(fn) {
    const disposer = fn();
    effects.push(disposer);
    return disposer;
  },
  inject(_deps, cb) {
    cb(hostScope);
  },
  logger: { info() {}, warn() {} },
};

host.apply(hostCtx);

check('guard registered', guards.length, 1);
check('rpc channel registered', rpcChannel, host.CHANNEL);
check('command registered', commands.map((c) => c.name), ['readonly']);

const guard = guards[0];
const call = (name, sessionId, args) =>
  guard({ name, arguments: args, agent: { session: { header: { id: sessionId } } } });

check('unarmed session allows write', call('write', 's1'), undefined);

const armed = await rpcHandler('set', { sessionId: 's1', active: true });
check('rpc set on', armed, { ok: true, value: { sessionId: 's1', active: true } });
check('rpc get on', await rpcHandler('get', { sessionId: 's1' }), {
  ok: true,
  value: { sessionId: 's1', active: true },
});
check('rpc get other session', await rpcHandler('get', { sessionId: 's2' }), {
  ok: true,
  value: { sessionId: 's2', active: false },
});

check('armed: read allowed', call('read', 's1'), undefined);
check('armed: grep allowed', call('grep', 's1'), undefined);
check('armed: write denied', typeof call('write', 's1'), 'string');
check('armed: edit denied', typeof call('edit', 's1'), 'string');
check('armed: pwsh denied', typeof call('pwsh', 's1'), 'string');
check('armed: present denied', typeof call('present', 's1'), 'string');
check('armed: subagent denied', typeof call('subagent', 's1'), 'string');
check('armed: workflow denied', typeof call('workflow', 's1'), 'string');
check('armed: unlisted tool denied', typeof call('some_future_writer', 's1'), 'string');
check('armed: other session unaffected', call('write', 's2'), undefined);
check('armed: blender_rt_see allowed', call('blender_rt_see', 's1'), undefined);
check('armed: blender_rt_headless denied', typeof call('blender_rt_headless', 's1'), 'string');
check('armed: univer_inspect allowed', call('univer_inspect', 's1'), undefined);
check('armed: univer_execute denied', typeof call('univer_execute', 's1'), 'string');
check('armed: github read allowed', call('mcp__github__get_file_contents', 's1'), undefined);
check('armed: github search allowed', call('mcp__github__search_code', 's1'), undefined);
check('armed: github write denied', typeof call('mcp__github__create_issue', 's1'), 'string');
check('armed: working_directory read allowed', call('working_directory', 's1', {}), undefined);
check('armed: working_directory cd denied', typeof call('working_directory', 's1', { cd: 'x' }), 'string');
check('armed: blender_viewport status allowed', call('blender_viewport', 's1', { op: 'status' }), undefined);
check('armed: blender_viewport start denied', typeof call('blender_viewport', 's1', { op: 'start' }), 'string');
check('armed: deny message mentions tool', call('write', 's1').includes('"write"'), true);

check('rpc set off', await rpcHandler('set', { sessionId: 's1', active: false }), {
  ok: true,
  value: { sessionId: 's1', active: false },
});
check('disarmed: write allowed again', call('write', 's1'), undefined);
check('rpc bad payload', (await rpcHandler('set', { sessionId: 's1' })).ok, false);
check('rpc unknown endpoint', (await rpcHandler('nope', { sessionId: 's1' })).ok, false);
check('rpc list', await rpcHandler('list', {}), { ok: true, value: { sessions: [] } });

const cmd = commands[0];
const run = (rawInput) => cmd.handler({ rawInput, agent: { session: { header: { id: 's9' } } } });
check('command status', run('status').text.includes('已关闭'), true);
check('command on', run('on').text.includes('已开启'), true);
check('command status after on', run('status').text.includes('已开启'), true);
check('command toggle', run('toggle').text.includes('已关闭'), true);
check('command bad word', run('wat').kind, 'error');
check('command no session', cmd.handler({ rawInput: 'on', agent: {} }).kind, 'error');

/* ---------------- client half ---------------- */
let clientDef;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      clientDef = def;
    },
  },
};
const styleNodes = [];
globalThis.document = {
  createElement() {
    return { dataset: {}, textContent: '', remove() {} };
  },
  head: { appendChild(node) { styleNodes.push(node); } },
};

await import(pkgUrl('client.js'));
check('client module id', clientDef?.id, '@local/dsh-readonly-mode');

check('react was not required at load time', typeof clientDef.factory, 'function');

const registered = [];
const localeRegistered = [];
const bindCalls = [];
const clientCtx = {
  get(name) {
    return name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: { active: false } }) } } : undefined;
  },
  effect(fn) {
    return fn();
  },
  locale: {
    register(ns, dicts) {
      localeRegistered.push([ns, Object.keys(dicts)]);
      return Promise.resolve();
    },
    bind(ns) {
      return (key) => {
        bindCalls.push(key);
        return key;
      };
    },
  },
  slots: {
    inject(root, factory) {
      check('client slot root', root, 'conversation.input.right');
      factory();
    },
    register(options, component) {
      registered.push({ options, component });
    },
  },
};

const clientModule = clientDef.factory((specifier) => {
  if (specifier !== 'react') throw new Error(`unexpected require(${specifier})`);
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
});

check('client inject list', clientModule.inject, ['slots', 'locale', 'connection']);
clientModule.apply(clientCtx);

check('locale namespace', localeRegistered, [['readonly-mode', ['zh', 'en']]]);
check('style injected', styleNodes.length, 1);
check('style tagged', styleNodes[0].dataset.plugin, 'dsh-readonly-mode');
check('slot registered once', registered.length, 1);
check('slot name', registered[0].options.name, 'conversation.input.right');
check('slot id', registered[0].options.id, 'readonly-mode');
check('slot order', registered[0].options.order, 20);
check('component is function', typeof registered[0].component, 'function');
check('slot props carry sessionId', registered[0].options.inject('s1').sessionId, 's1');
check('slot props carry translator', typeof registered[0].options.inject('s1').t, 'function');
check('translator has fallback', clientCtx.locale.bind('x')('label'), 'label');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
