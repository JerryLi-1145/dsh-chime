# dsh-chime

给 Harness Web UI 加一个 Codex 那样的提示音：

- **请求权限**：会话里出现 `approval/asked`（工具要越权执行、等你点「允许一次」）时，响两声上行的三角波。
- **任务完成**：`turn/end` 的原因为 `completed` 时，响一段 C 大调琶音。

声音由 Web Audio 现场合成，不附带任何音频文件。行为对齐 Codex 的两个提醒时机；音色是这里自己设计的，没有采样或复刻 Codex 的音频。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：监听 `session/event` 里的 `approval/asked` 和 `turn/end`，放进内存队列；注册 `GET /dsh-chime/poll?since=<cursor>` 长轮询端点 |
| `client.js` | 浏览器半侧：长轮询队列，用 Web Audio 播放；首次点击/按键时解锁 `AudioContext` |
| `cordis.patch.yml` | 把插件行 `dsh-chime` 插进配置树 |
| `locale/*.json` | 插件管理页里的名称与说明（中/英） |
| `icon.svg` | 插件图标 |

## 行为细节

- **权限音在 Host 侧判定**：`approval/asked` 是审批服务落日志时发出的可靠信号。没有监听浏览器侧的 `approval/request` 瀑布——审批 UI 占着那条链，排在它后面的监听器要等用户答完才轮到。
- **自动审批也会响**：如果请求被自动审批放行（页面上没有出现审批面板），这里仍会响，因为它确实产生了一次权限申请。嫌吵就在「设置 → 插件」里禁用整个插件。
- **完成音对子代理静音**：`header.origin === 'subagent'` 或 `delegationDepth > 0` 的会话不响完成音，避免主任务派出 3 个子代理时连响 3 次。权限音不过滤：它阻塞工作，无论来自哪条会话都值得提醒。
- **不重放**：页面加载后第一次请求只取当前游标；刷新页面不会把历史提示音补一遍。
- **失败不响**：`turn/end` 的 `error` / `aborted` / `max-tokens` 都不响；这里只做「完成」提示。
- **限流**：同一种提示音 1.2 秒内只响一次。
- **自动播放策略**：页面第一次有指针或键盘事件之前，`AudioContext` 处于 suspended；期间到达的提示音会被记住，解锁后补响一次。要立刻听到，先在页面上点一下或按一次键。

## 开关

在「设置 → 插件」里禁用 `dsh-chime` 即可整体静音，不需要改配置。

## 调音

- 音量：`client.js` 里 `master.gain.value = 0.2`。
- 权限音：`render()` 的 `approval` 分支（频率、时长、增益）。
- 完成音：`render()` 的 `notes` 数组，每项为 `[频率, 时长, 增益]`。

改完 `client.js` / `index.js` 后需要重新安装这个 bundle（或重启 Harness）才会加载新代码；纯文件热更新不保证生效。

## 端点

- `GET /dsh-chime/poll?since=-1`：基线，立即返回当前游标。
- `GET /dsh-chime/poll?since=<n>`：有 `seq > n` 的事件立即返回，否则最多挂起 20 秒。
- `GET /dsh-chime/status`：`{ cursor, waiters }`，确认浏览器半侧是否正在长轮询。
- 响应：`{ "cursor": number, "events": [{ "seq", "kind", "at" }] }`；游标落后于缓冲窗口时带 `"reset": true`。

提示帧只含 `kind` 与时间戳，不带会话 id、工具名或命令文本。
