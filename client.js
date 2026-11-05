window.__ModuleLoader__.load({
  id: '@local/dsh-readonly-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ID = 'readonly-mode';
    const CHANNEL = '/dsh-readonly-mode';

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

    function fetchOf() {
      try {
        if (typeof fetch === 'function') return fetch;
      } catch (error) {
        /* fall through to the global lookup */
      }
      try {
        const scope = typeof globalThis !== 'undefined' ? globalThis : undefined;
        if (scope && typeof scope.fetch === 'function') return scope.fetch.bind(scope);
      } catch (error) {
        /* no fetch in this page */
      }
      return undefined;
    }

    /**
     * One call to the Host half. The switch travels over a plain route on the web
     * server, never as a slash command: a command execution appends
     * `command/run` + `command/done` to the session log and would show up in the
     * conversation every time the composer reads the state.
     */
    async function callHost(path, init) {
      const request = fetchOf();
      if (request === undefined) throw new Error('fetch is unavailable in this page');
      const response = await request(CHANNEL + path, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...init,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error('host half answered ' + response.status + ': ' + text.slice(0, 120));
      }
      if (payload && payload.ok === true) return payload.value;
      const failure = payload && payload.error;
      throw new Error(
        (failure && (failure.message || failure.code)) || 'host half answered ' + response.status,
      );
    }

    /** Current switch state for one session. */
    async function readState(ctx, sessionId) {
      const value = await callHost('/get?sessionId=' + encodeURIComponent(sessionId));
      if (value && typeof value.active === 'boolean') return value.active;
      throw new Error('host half did not report a read-only state');
    }

    /** Flip the switch for one session; resolves with the state the host stored. */
    async function writeState(ctx, sessionId, active) {
      const value = await callHost('/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, active }),
      });
      if (value && typeof value.active === 'boolean') return value.active;
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
              console.error('[readonly-mode] could not read the switch state', error);
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
              console.error('[readonly-mode] could not switch', error);
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
      // No service beyond `slots` and `locale` is required: the host half is reached
      // over `fetch`, so a build that does not expose `connection` or `remote` to a
      // Client plugin still mounts the switch.
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

        console.log('[readonly-mode] client half mounted in conversation.input.right');
      },
    };
  },
});
