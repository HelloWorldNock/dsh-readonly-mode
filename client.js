window.__ModuleLoader__.load({
  id: '@local/dsh-readonly-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ID = 'readonly-mode';
    const CHANNEL = '/dsh-readonly-mode';
    const STATE_TOKEN = /readonly=(on|off)/i;

    const FALLBACK = {
      label: '只读',
      off: '开启只读模式：本会话将只执行读取操作',
      on: '只读模式已开启：本会话只执行读取操作，点击关闭',
      error: '只读模式状态读取失败，点击重试',
      busy: '正在切换只读模式…',
      unknown: '只读模式状态未知，点击切换',
    };

    const STYLE = `
.dsrom-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s,color .15s;}
.dsrom-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.dsrom-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.dsrom-btn:disabled{opacity:.55;cursor:default;}
.dsrom-btn--on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);}
.dsrom-btn--on:hover:not(:disabled){color:var(--dsw-alias-brand-primary);}
.dsrom-btn--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dsrom-btn__icon{width:14px;height:14px;display:block;flex:none;}
`;

    function icon(active) {
      // Closed padlock when read-only is on, open padlock when writes are allowed.
      return h(
        'svg',
        {
          className: 'dsrom-btn__icon',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          'aria-hidden': true,
        },
        h('rect', { x: 3.5, y: 7, width: 9, height: 6.2, rx: 1.4 }),
        active
          ? h('path', { d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7' })
          : h('path', { d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.6-.9' }),
      );
    }

    /** Session id out of whatever the slot hands us: a string, or a props object. */
    function sessionIdOf(props) {
      if (typeof props === 'string') return props;
      const candidates = [
        props && props.sessionId,
        props && props.session && props.session.id,
        props && props.session && props.session.header && props.session.header.id,
        props && props.scope && props.scope.sessionId,
        props && props.scope && props.scope.id,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate;
      }
      return undefined;
    }

    /**
     * A service, however this build exposes it: `ctx.get(name)` where the context has
     * a service registry, a plain property where it does not. Never throws.
     */
    function serviceOf(ctx, name) {
      let viaGet;
      try {
        viaGet = ctx.get(name);
      } catch (error) {
        viaGet = undefined;
      }
      if (viaGet !== undefined && viaGet !== null) return viaGet;
      try {
        const direct = ctx[name];
        if (direct !== undefined && direct !== null) return direct;
      } catch (error) {
        /* a strict context refuses undeclared services; treat that as absent */
      }
      return undefined;
    }

    function rpcOf(ctx) {
      const connection = serviceOf(ctx, 'connection');
      const rpc = connection && connection.rpc;
      return rpc && typeof rpc.call === 'function' ? rpc : undefined;
    }

    /** Text out of a command result, tolerating the shapes a command may return. */
    function textOf(value) {
      if (typeof value === 'string') return value;
      if (value && typeof value.text === 'string') return value.text;
      if (value && typeof value.message === 'string') return value.message;
      return '';
    }

    /** The commands service: `remote.commands` when present, else the bare service. */
    function commandsOf(ctx) {
      const remote = serviceOf(ctx, 'remote');
      const candidates = [remote && remote.commands, serviceOf(ctx, 'commands')];
      for (const candidate of candidates) {
        if (candidate && typeof candidate.execute === 'function') return candidate;
      }
      return undefined;
    }

    async function runCommand(ctx, sessionId, line) {
      const commands = commandsOf(ctx);
      if (commands === undefined) {
        throw new Error('commands service is unavailable');
      }
      const result = await commands.execute(sessionId, line, []);
      if (!result || result.ok !== true) {
        const error = result && result.error;
        throw new Error((error && error.message) || 'command failed');
      }
      const text = textOf(result.value);
      const match = STATE_TOKEN.exec(text);
      if (match === null) throw new Error(text || 'command returned no read-only state');
      return match[1].toLowerCase() === 'on';
    }

    /**
     * Current switch state. The `/readonly` command is the primary transport: it is
     * the documented Client → Host path for a user action and does not depend on the
     * package RPC channel, which some host builds cannot serve to a plugin. The RPC
     * channel stays as a secondary path where `connection.rpc` does resolve.
     */
    async function readState(ctx, sessionId) {
      if (commandsOf(ctx) !== undefined) {
        return await runCommand(ctx, sessionId, '/readonly status');
      }
      const rpc = rpcOf(ctx);
      if (rpc === undefined) throw new Error('no transport to the host half');
      const result = await rpc.call(CHANNEL, 'get', { sessionId });
      if (result && result.ok === true && result.value && typeof result.value.active === 'boolean') {
        return result.value.active;
      }
      throw new Error('host half did not report a read-only state');
    }

    /** Flip the switch, command first for the same reason as `readState`. */
    async function writeState(ctx, sessionId, active) {
      if (commandsOf(ctx) !== undefined) {
        return await runCommand(ctx, sessionId, active ? '/readonly on' : '/readonly off');
      }
      const rpc = rpcOf(ctx);
      if (rpc === undefined) throw new Error('no transport to the host half');
      const result = await rpc.call(CHANNEL, 'set', { sessionId, active });
      if (result && result.ok === true && result.value && typeof result.value.active === 'boolean') {
        return result.value.active;
      }
      throw new Error('host half did not accept the switch');
    }

    function createToggle(ctx, t) {
      return function ReadOnlyToggle(props) {
        const sessionId = sessionIdOf(props);
        const [active, setActive] = React.useState(null);
        const [phase, setPhase] = React.useState('loading');
        const [busy, setBusy] = React.useState(false);
        const [note, setNote] = React.useState('');

        React.useEffect(() => {
          if (sessionId === undefined) {
            setActive(null);
            setPhase('unknown');
            return undefined;
          }
          let cancelled = false;
          // A different session starts from an unknown state, never from the previous one.
          setActive(null);
          setPhase('loading');
          readState(ctx, sessionId)
            .then((value) => {
              if (cancelled) return;
              setActive(value);
              setPhase('ready');
            })
            .catch((error) => {
              if (cancelled) return;
              setActive(null);
              setPhase('error');
              setNote(error && error.message ? String(error.message) : '');
            });
          return () => {
            cancelled = true;
          };
        }, [sessionId]);

        const toggle = () => {
          if (busy || phase === 'loading' || sessionId === undefined) return;
          setBusy(true);
          writeState(ctx, sessionId, active !== true)
            .then((value) => {
              setActive(value);
              setPhase('ready');
              setNote('');
            })
            .catch((error) => {
              setPhase('error');
              setNote(error && error.message ? String(error.message) : '');
            })
            .then(() => setBusy(false));
        };

        const on = active === true;
        const className =
          'dsrom-btn' + (on ? ' dsrom-btn--on' : '') + (phase === 'error' ? ' dsrom-btn--error' : '');
        const base = phase === 'error' ? t('error') : busy ? t('busy') : on ? t('on') : t('off');
        const title = note === '' ? base : base + ' — ' + note;

        return h(
          'button',
          {
            type: 'button',
            className,
            title,
            'aria-label': title,
            'aria-pressed': on ? 'true' : 'false',
            'data-readonly-mode': phase === 'loading' ? 'unknown' : on ? 'on' : 'off',
            disabled: busy || phase === 'loading',
            onClick: toggle,
          },
          icon(on),
          h('span', { className: 'dsrom-btn__label' }, t('label')),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dicts = {
          zh: {
            label: FALLBACK.label,
            off: FALLBACK.off,
            on: FALLBACK.on,
            error: FALLBACK.error,
            busy: FALLBACK.busy,
            unknown: FALLBACK.unknown,
          },
          en: {
            label: 'Read-only',
            off: 'Enable read-only mode: this session will only run read operations',
            on: 'Read-only mode is on: this session only runs read operations. Click to allow writes',
            error: 'Could not read the read-only state. Click to retry',
            busy: 'Switching read-only mode…',
            unknown: 'Read-only state unknown. Click to switch',
          },
        };

        try {
          const registered = ctx.locale.register(ID, dicts);
          if (registered && typeof registered.catch === 'function') registered.catch(() => {});
        } catch (error) {
          console.error('[readonly-mode] locale registration failed', error);
        }

        const t = (key) => {
          try {
            const value = ctx.locale.bind(ID)(key);
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          } catch (error) {
            /* fall through to the built-in strings */
          }
          return FALLBACK[key] ?? key;
        };

        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-readonly-mode';
        style.textContent = STYLE;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-readonly-mode: styles');

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: ID,
              order: 20,
              inject: (sessionId) => ({ sessionId }),
            },
            createToggle(ctx, t),
          ),
        );
      },
    };
  },
});
