# 会话只读模式 · Read-only Mode

一个 DeepSeek Harness（DSH）插件：在输入框右侧加一个「只读」开关。打开后，该会话只放行读取类工具，任何写入、命令执行、委派与生成类调用都会在**执行之前**被拒绝——直到你关掉它。

Per-session read-only switch for the DSH chat composer. While armed, every tool call outside a curated read-only allowlist is denied before it runs.

## 解决的问题

模型「看一眼」和「改一下」用的是同一套工具权限。让它读日志、查仓库、翻文档时，顺手 `write`、`pwsh`、`git commit` 并不奇怪，事后再回滚代价不小。

现有的 permission preset 管的是**沙箱与审批**，是部署级设置：换 preset 会改整个部署的行为，而 `danger-full-access`（审批关闭）下没有任何按会话的刹车。本插件把刹车下放到单个会话：开关打开时，工具层直接拒绝一切非读取调用，不需要改沙箱、不需要人来点审批。

## 功能

- **输入框右侧的锁形开关**：关闭时是开锁图标，打开时是闭锁图标并染上品牌色；带 `aria-pressed`、悬停说明，加载/请求中自动禁用。
- **与命令同源**：`/readonly on | off | toggle | status`，界面与命令读写同一份状态。
- **按会话生效**：状态以会话 ID 为键，别的会话不受影响。
- **拒绝在工具执行前发生**：模型收到明确的拒绝原因（中英双语），并被告知请你关闭开关，而不是拿到一个静默失败。
- **委派一并拦住**：`subagent`、`workflow` 不在放行表内，只读会话无法通过子会话绕回写入。
- **开关只能由用户操作**：界面通过 `/readonly` 命令读写状态，模型侧没有任何工具能打开或关闭它。
- **不依赖单一通道**：优先走命令；若构建里能拿到 `connection.rpc`，包内 RPC 通道会自动启用并优先使用。宿主换版本导致其中一条路断掉时，开关不会变成死按钮。
- **可诊断**：宿主把启动、通道注册结果、拦截记录追加到系统临时目录的 `dsh-readonly-mode.log`，出问题时先看这个文件。

## 安装

插件是一个 DSH bundle（`dsh.bundle.patch` 指向包内的 `cordis.patch.yml`），用插件管理器从本仓库目录安装：

```
plugin_manager action=install_bundle target="<本仓库目录的绝对路径>"
```

安装后 **刷新页面**（必要时 Ctrl+F5）生效。用 `link:` 方式安装时，改代码只要刷新页面即可。

包名保持 `@local/dsh-readonly-mode`（DSH 的本地 bundle 惯例）。要改成自己的作用域，需同时修改 `package.json` 的 `name` 与 `cordis.patch.yml` 里的 `name`。

## 使用

- 点输入框右侧的锁图标，或
- 在输入框输入 `/readonly`：

| 命令 | 效果 |
| --- | --- |
| `/readonly on` | 打开当前会话的只读模式 |
| `/readonly off` | 关闭 |
| `/readonly toggle` | 反转当前状态 |
| `/readonly status` | 只报告状态，不改变 |

## 打开时放行什么

白名单在 `index.js` 的 `READ_TOOLS` 里，**不在表内的工具一律拒绝**（失败即拒绝）。

- 文件与检索：`read`、`grep`、`glob`、`read_image`
- 网络：`web_search`、`web_fetch`、`read_page`、`x_search`
- 会话与上下文：`skill`、`ask_user_question`、`get_goal`、`list_agents`、`job_list`、`job_output`、`compress`、`decompress`、`search_context`、`acp_status`、`acp_cache`、`acp_read_original_image`
- 宿主自省：`cordis_inspect_list`、`cordis_inspect_query`、`load_workspace_dependencies`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`
- 文档与 3D 只读查询：`univer_status`、`univer_inspect`、`univer_lint`、`univer_screenshot`、`univer_api`、`blender_rt_commands`、`blender_rt_see`
- GitHub 只读：`mcp__github__get_*`、`mcp__github__list_*`、`mcp__github__search_*`、`mcp__github__issue_read`、`mcp__github__pull_request_read`、`mcp__github__ui_get`、`mcp__github__get_me`、`mcp__github__run_secret_scanning`
- 两个带参数的例外：
  - `working_directory` 只在**不带 `cd`** 时放行（带 `cd` 会改变工作目录，算写）。
  - `blender_viewport` 只放行 `status`、`doctor`、`who` 三个只读子命令。

## 工作原理

| 环节 | 做法 | 依赖的宿主契约 |
| --- | --- | --- |
| 状态 | 宿主进程内存里的 `Set<sessionId>`；界面通过 `/readonly status|on|off` 命令（`ctx.remote.commands.execute`）读写，命令输出带 `readonly=on\|off` 标记供解析。包内 RPC 通道 `/dsh-readonly-mode` 在能拿到 `connection.rpc` 的构建上作为备选 | `remote.commands.execute` · `connection.rpc.handle/call` |
| 开关 | 注册进 `conversation.input.right` 槽，`inject: (sessionId) => ({ sessionId })`；客户端只硬依赖 `slots` 与 `locale`，其余服务按需懒取 | `slots.register` |
| 拦截 | `ctx.tools.guard(fn)` 全局守卫：按 `execution.agent.session.header.id` 查表，不在放行表内就返回拒绝原因 | `ToolGuard = (execution) => string \| undefined` |
| 命令 | `ctx.commands.register({ name: 'readonly', recordInput: false, handler })` | `CommandDefinition` |
| 文案 | `ctx.locale.register('readonly-mode', { zh, en })`，slot 内 `t()` 本地化 | Client locale 服务 |
| 样式 | 一段注入的 `<style>`，只用 `--dsw-alias-*` 主题变量，深浅色跟随主题 | 主题 token |

## 已知限制

- 状态存在**宿主内存**：重启 DSH 即清空，不跨会话、不跨设备。刻意不做持久化——只读是一个「现在要小心」的手动状态，不是账号配置。
- 白名单是人工维护的：新装的工具默认被当作「写」，要放行得改 `READ_TOOLS`。这是有意的取舍，失败方向永远是拒绝。
- 只拦**工具调用**：不改沙箱、审批与文件系统权限；已在运行的后台作业、宿主自身的会话落盘（日志、压缩）不受影响。
- 拒绝以工具错误返回给模型，模型可能换个写法重试——仍然会被拒绝，但会多花一轮。
- `univer_screenshot` 与 `blender_rt_see` 会把 PNG 写到磁盘，是为了让模型「看」而保留的例外（产物在临时/输出目录）。
- 与 permission preset 是叠加关系：preset 是部署级，本插件是会话级，两者不互相替代。
- 依赖 DSH 的契约（slots / commands / `remote.commands` / `tools.guard`）。已在 `0.2.2-rc.1` 上跑通；宿主升级后接口若有变化，需要同步调整。
- 桌面版 `0.2.2-rc.1` 里第三方插件拿不到 `connection.rpc`（注册时报 `cannot get property "webServer" without inject`），所以包内 RPC 通道在这类构建上会被跳过，界面改走命令通道。日志里能看到这一行，属预期。

## 变更记录

- **0.2.1** — 界面侧改为硬注入 `remote.commands` 并直接用 `ctx.remote.commands.execute`：在 `0.2.2-rc.1` 的客户端里 `remote` 是服务而不是属性，不声明注入就取不到，开关会停在错误态（红色）。
- **0.2.0** — 适配 DSH `0.2.2-rc.1`。失效原因是界面侧状态读取走的那条通道在该构建里不可用：客户端硬注入了 `connection`（拿不到时整个客户端半边不挂载），且宿主侧 `connection.rpc.handle` 直接抛 `cannot get property "webServer" without inject`。现在：客户端状态读写改走 `/readonly` 命令（命令输出带 `readonly=on|off` 机器可读标记），RPC 通道降为备选；会话 ID 解析补了多种形状兜底；新增宿主侧诊断日志。
- **0.1.0** — 首版：全局工具守卫 + 输入框右侧锁形开关 + `/readonly` 命令。

## 自测

```
node test.mjs
```

不启动 Harness：脚本伪造 `ctx`、`scope`、`window.__ModuleLoader__` 与 `document`，直接驱动真实的 `index.js` 与 `client.js`，覆盖守卫判定（放行/拒绝/参数例外/跨会话隔离）、RPC 端点、`/readonly` 四个子命令，以及客户端插槽注册。不能替代真机验证（真实 Cordis 选项、真实 React 渲染、真实点击）。

## License

MIT
