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
      if (active) {
        return h(
          'svg',
          { className: 'dsrom-btn__icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
          h('rect', { x: 3.5, y: 7, width: 9, height: 6.2, rx: 1.4 }),
          h('path', { d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7' }),
        );
      }
      return h(
        'svg',
        { className: 'dsrom-btn__icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        h('rect', { x: 3.5, y: 7, width: 9, height: 6.2, rx: 1.4 }),
        h('path', { d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.6-.9' }),
      );
    }

    function createToggle(ctx, t) {
      return function ReadOnlyToggle(props) {
        const sessionId = props && props.sessionId;
        const [active, setActive] = React.useState(false);
        const [phase, setPhase] = React.useState('loading');
        const [busy, setBusy] = React.useState(false);

        React.useEffect(() => {
          let cancelled = false;
          const connection = ctx.get('connection');
          const rpc = connection && connection.rpc;
          if (!sessionId || !rpc || typeof rpc.call !== 'function') {
            setPhase('unavailable');
            return undefined;
          }
          setPhase('loading');
          rpc
            .call(CHANNEL, 'get', { sessionId })
            .then((result) => {
              if (cancelled) return;
              if (result && result.ok === true && result.value) {
                setActive(result.value.active === true);
                setPhase('ready');
              } else {
                setPhase('error');
              }
            })
            .catch(() => {
              if (!cancelled) setPhase('error');
            });
          return () => {
            cancelled = true;
          };
        }, [sessionId]);

        if (phase === 'unavailable' || !sessionId) return null;

        const toggle = () => {
          if (busy || phase === 'loading') return;
          const connection = ctx.get('connection');
          const rpc = connection && connection.rpc;
          if (!rpc || typeof rpc.call !== 'function') {
            setPhase('unavailable');
            return;
          }
          setBusy(true);
          rpc
            .call(CHANNEL, 'set', { sessionId, active: !active })
            .then((result) => {
              if (result && result.ok === true && result.value) {
                setActive(result.value.active === true);
                setPhase('ready');
              } else {
                setPhase('error');
              }
            })
            .catch(() => setPhase('error'))
            .then(() => setBusy(false));
        };

        const className =
          'dsrom-btn' + (active ? ' dsrom-btn--on' : '') + (phase === 'error' ? ' dsrom-btn--error' : '');
        const title =
          phase === 'error' ? t('error') : active ? t('on') : t('off');

        return h(
          'button',
          {
            type: 'button',
            className,
            title,
            'aria-label': title,
            'aria-pressed': active ? 'true' : 'false',
            'data-readonly-mode': active ? 'on' : 'off',
            disabled: busy || phase === 'loading',
            onClick: toggle,
          },
          icon(active),
          h('span', { className: 'dsrom-btn__label' }, t('label')),
        );
      };
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const dicts = {
          zh: { label: FALLBACK.label, off: FALLBACK.off, on: FALLBACK.on, error: FALLBACK.error },
          en: {
            label: 'Read-only',
            off: 'Enable read-only mode: this session will only run read operations',
            on: 'Read-only mode is on: this session only runs read operations. Click to allow writes',
            error: 'Could not read the read-only state. Click to retry',
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
              inject: (sessionId) => ({ sessionId, t }),
            },
            createToggle(ctx, t),
          ),
        );
      },
    };
  },
});
