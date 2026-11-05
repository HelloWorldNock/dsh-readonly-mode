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
  // `connection` is reachable through the fiber scope in current builds and through
  // root in older ones; the plugin must accept either.
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
check('rpc ping', (await rpcHandler('ping', {})).ok, true);

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

// Session shapes other than agent.session.header.id must still resolve.
const execWithoutAgent = { name: 'write', arguments: {}, session: { header: { id: 's1' } } };
check('denied via session.header.id fallback', typeof guard(execWithoutAgent), 'string');
const execWithSessionId = { name: 'write', arguments: {}, sessionId: 's1' };
check('denied via sessionId fallback', typeof guard(execWithSessionId), 'string');

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
check('command text carries token on', /readonly=on/.test(run('on').text), true);
check('command text carries token off', /readonly=off/.test(run('off').text), true);

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

/** Minimal hook runtime: hook slots persist across renders, effects flush on demand. */
function makeReactRuntime() {
  const runtime = {
    cursor: 0,
    values: [],
    effects: [],
  };
  runtime.api = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = runtime.cursor;
      runtime.cursor += 1;
      if (!(index in runtime.values)) runtime.values[index] = initial;
      const set = (next) => {
        runtime.values[index] = typeof next === 'function' ? next(runtime.values[index]) : next;
      };
      return [runtime.values[index], set];
    },
    useEffect(fn) {
      runtime.effects.push(fn);
    },
  };
  runtime.render = (component, props) => {
    runtime.cursor = 0;
    runtime.effects.length = 0;
    return component(props);
  };
  runtime.flush = () => runtime.effects.splice(0).map((fn) => fn());
  return runtime;
}

/** Mount the client half against a fake context and return what it registered. */
async function mountClient(get) {
  const registered = [];
  const localeRegistered = [];
  const ctx = {
    get,
    effect(fn) {
      return fn();
    },
    locale: {
      register(ns, dicts) {
        localeRegistered.push([ns, Object.keys(dicts)]);
        return Promise.resolve();
      },
      bind() {
        return (key) => key;
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
  const runtime = makeReactRuntime();
  const module = clientDef.factory((specifier) => {
    if (specifier !== 'react') throw new Error(`unexpected require(${specifier})`);
    return runtime.api;
  });
  module.apply(ctx);
  return { module, registered, localeRegistered, runtime };
}

/* --- scenario A: the package RPC channel answers --- */
const rpcCalls = [];
const scenarioA = await mountClient((name) =>
  name === 'connection'
    ? {
        rpc: {
          async call(channel, endpoint, payload) {
            rpcCalls.push([channel, endpoint, payload]);
            return { ok: true, value: { sessionId: payload.sessionId, active: endpoint === 'get' } };
          },
        },
      }
    : undefined,
);

check('client inject list', scenarioA.module.inject, ['slots', 'locale']);
check('locale namespace', scenarioA.localeRegistered, [['readonly-mode', ['zh', 'en']]]);
check('style tagged', styleNodes[0].dataset.plugin, 'dsh-readonly-mode');
check('slot name', scenarioA.registered[0].options.name, 'conversation.input.right');
check('slot id', scenarioA.registered[0].options.id, 'readonly-mode');
check('slot order', scenarioA.registered[0].options.order, 20);
check('slot props carry sessionId', scenarioA.registered[0].options.inject('s1').sessionId, 's1');
check('slot props are only the session', Object.keys(scenarioA.registered[0].options.inject('s1')), ['sessionId']);

const toggleA = scenarioA.registered[0].component;
const elementA = scenarioA.runtime.render(toggleA, { sessionId: 's1' });
check('button element type', elementA.type, 'button');
check('button starts disabled while loading', elementA.props.disabled, true);
scenarioA.runtime.flush();
await new Promise((resolve) => setTimeout(resolve, 0));
check('rpc get used on mount', rpcCalls[0], [host.CHANNEL, 'get', { sessionId: 's1' }]);
check('state settled to on', scenarioA.runtime.values[0], true);
check('phase settled to ready', scenarioA.runtime.values[1], 'ready');

scenarioA.runtime.render(toggleA, {});
scenarioA.runtime.flush();
const noSession = scenarioA.runtime.render(toggleA, {});
check('button rendered without a session id too', noSession.type, 'button');
check('without a session id it is not armed', noSession.props['data-readonly-mode'], 'off');

/* --- scenario B: no RPC channel, the /readonly command carries the state --- */
const commandCalls = [];
const scenarioB = await mountClient((name) => {
  if (name === 'remote') {
    return {
      commands: {
        async execute(sessionId, line) {
          commandCalls.push([sessionId, line]);
          const on = line !== '/readonly off';
          return { ok: true, value: { kind: 'success', text: on ? '已开启。readonly=on' : '已关闭。readonly=off' } };
        },
      },
    };
  }
  return undefined;
});

const toggleB = scenarioB.registered[0].component;
const elementB = scenarioB.runtime.render(toggleB, { sessionId: 's7' });
check('fallback: button visible', elementB.type, 'button');
scenarioB.runtime.flush();
await new Promise((resolve) => setTimeout(resolve, 0));
check('fallback read used the command', commandCalls[0], ['s7', '/readonly status']);
check('fallback parsed on', scenarioB.runtime.values[0], true);

// A second render is what React does after the state update; its click closure
// then sees the settled phase instead of the initial "loading".
const elementB2 = scenarioB.runtime.render(toggleB, { sessionId: 's7' });
check('settled button is enabled', elementB2.props.disabled, false);
elementB2.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('fallback write used the command', commandCalls[1], ['s7', '/readonly off']);

/* --- scenario C: no transport at all --- */
const scenarioC = await mountClient(() => undefined);
const elementC = scenarioC.runtime.render(scenarioC.registered[0].component, { sessionId: 's3' });
scenarioC.runtime.flush();
await new Promise((resolve) => setTimeout(resolve, 0));
check('no transport still renders', elementC.type, 'button');
check('no transport lands in error', scenarioC.runtime.values[1], 'error');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
