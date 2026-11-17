# AgentDeck 1.0.2

AgentDeck 是面向 Windows 的本地优先多 Agent 工作台，把 Codex、Claude Code、Cursor、DeepSeek Harness 和 WorkBuddy 会话集中到一个界面。用户可以订阅关心的对话，在需要输入或处理时收到提醒，跳回原会话，并从本地记录查看每日 Agent 活动时长。也支持添加任意 JSONL 来源，让自定义 Agent 同时进入会话发现、筛选、订阅监控和使用统计。

AgentDeck 是基于 [0xFANGO/agent-inbox](https://github.com/0xFANGO/agent-inbox)（MIT）二次开发并由社区独立维护的非官方 Windows 版本。产品方向、需求拆解、编写与验收由 [@3121597355](https://github.com/3121597355) 主导，使用 OpenAI Codex 作为结对开发 Agent 完成代码实现、测试、调试与发布迭代。

1.0.2 更新了应用、窗口、任务栏、托盘以及 Windows 快捷方式图标：新图标用层叠卡片和三节点网络表示多 Agent 汇聚，取消了旧版的紫色下载箭头。

## 使用

支持 Windows 10 / 11 x64。解压完整应用目录后双击 **AgentDeck.exe**。无需安装 Node、SQLite 或 Raycast。请保留 exe 旁的 resources 和 DLL 文件。

1. 首次打开后进入“全部会话”，读取本机真实记录。搜索标题、项目或 ID，选择“订阅”。
2. 在“收件箱”查看关注的会话，在“待我处理”查看未解决问题、授权或异常。
3. DeepSeek Harness 和 WorkBuddy 自动读取本地记录，无需修改它们的配置。“设置与接入”中可接入 Codex、Claude Code、Cursor Hook：显示变更预览，备份原配置再写入。Codex 支持 `/hooks` 的版本还需在客户端确认。接入后请重新加载客户端配置或创建新会话。
4. 点击“返回会话”使用客户端可用入口；Cursor 和 DeepSeek Harness 当前只唤起应用并复制会话 ID，会明确提示。Codex、Claude Code 的“在终端恢复”使用已安装的 `codex resume` / `claude --resume`。
5. 标记已处理会暂时收起会话；新的状态或请求会恢复显示。
6. 打开“使用统计”查看近 7 / 14 / 30 天的合并活动时长、活跃天数、每日趋势、来源分布和每日明细。应用启动后会在后台预热近 7 天统计，结果缓存 60 秒。
7. 在“使用统计 → 来源分布”点击“添加 Agent”，可选择本地文件或目录、配置文件名模式和 JSON 时间戳字段。保存后立即刷新，不需要重启。
8. 要让任意 Agent 的会话出现在列表和筛选中，在“设置与接入 → Agent 接入”点击“＋ 添加 Agent”，展开“会话字段映射”，填写会话 ID、状态、标题、目录、摘要和请求 ID 字段。保存后同时扫描会话并计入使用统计。

关闭主窗口会收起到托盘，采集器继续运行。**Ctrl + Alt + I** 唤起或隐藏窗口。真正退出请用托盘菜单“退出 AgentDeck”。开机启动默认关闭，在设置中开启。首次运行会创建开始菜单快捷方式，以便 Windows 系统通知识别应用。

右上角的 **月亮／太阳按钮** 可以在夜间深色与日间浅色之间切换，鼠标悬停可查看目标模式。在“设置与接入 → 外观”可选择 **跟随系统、日间 · 浅色、夜间 · 深色**。默认跟随 Windows 外观；选择会保存在本机，重新打开仍然保留。手动切换后使用固定外观，想恢复自动切换时选择“跟随系统”。

会话名称按客户端的可用本地名称记录同步，**未订阅会话也会更新标题**。在 Codex 等客户端改名后，Inbox 会在后续自动刷新中更新列表和详情；不会因改名自动订阅、改变执行状态或发出提醒。Codex 优先读取当前数据库显示名，旧版本仅在名称索引保存改名时也能读取。

2026-11-13 界面更新：采用暖白／深灰与柔和绿色强调色，移除重复说明和大型统计卡片。列表保留标题、状态、项目和最近活动；选中后可直接返回会话、订阅或标记已处理。目录、会话 ID、终端恢复、打开项目和复制 ID 位于详情的 **“会话信息”** 中，接入能力说明可在设置中展开查看。

## 使用统计

- 默认显示近 7 天，可切换 14 / 30 天；四张概览卡显示去重总时长、有活动天数、活跃日均和单日最长。
- 每日趋势同时用柱形和折线展示合并活动时长；下方可按天查看 Codex、Claude Code、DeepSeek Harness、WorkBuddy 和去重总时长。
- 可添加任意自定义 Agent：支持本地单文件或目录递归扫描，文件模式如 `*.jsonl`，时间戳字段支持 `event.created_at` 这样的嵌套路径，以及自动、ISO、Unix 毫秒、Unix 秒四种格式。
- 自定义 Agent 可映射会话 ID、状态 / 事件、标题、工作目录、摘要和请求 ID。识别 `started`、`progress`、`needs_input`、`resolved`、`stopped`、`completed`、`failed`、`quota`、`interrupted` 等常见事件；也可以设置含 `{sessionId}` / `{cwd}` 的应用回跳链接。
- 自定义来源会同步进入“全部会话”、Agent 筛选、订阅监控和使用统计。停用后保留配置与已有订阅，但不再发现新会话；删除后清除该自定义 Agent 的 AgentDeck 本地订阅与状态记录，不改动原 JSONL 文件。
- 自定义来源可编辑、启停和删除；路径不存在、没有匹配文件或字段无法解析时会在来源卡里显示具体错误。配置保存在本地，修改后立即清空缓存并排队强制重扫，即使刚好撞上后台普通刷新也不会漏掉更新。
- Codex、Claude Code、DSH、WorkBuddy 使用本地记录中的真实事件时间戳。相邻活动间隔不超过 10 分钟时计入，超过则视为离开；多个 Agent 并行时总时长取时间线并集，只计算一次。
- 每个 Agent 的独立时长仍会单独显示，因此并行时段会出现来源时长之和大于合并总时长的情况，这是预期结果。
- Cursor 当前导出的本地 JSONL 不含逐条时间戳，页面会明确标为“未计入”，不会用会话首尾或文件修改时间伪造精确时长。
- 统计是 **Agent 活动时间估算**，包含 Agent 自动执行与等待时间，不等于人坐在电脑前的前台挂机时间。原会话正文不会被复制或上传，应用只为读取过的文件保存内存缓存。

## 支持能力与边界

- 五种客户端的本地记录发现、标题/项目/ID 搜索、订阅、状态采集、已处理与恢复；列表与接入页使用各客户端品牌图标。
- 本地 Agent 使用统计：7 / 14 / 30 天趋势、来源独立时长、并行去重、活跃天数、个人最长活动日，以及任意 JSONL 会话与时间戳来源。
- Windows 系统托盘、通知与点击处理、全局快捷键、可选开机启动。
- 完整日间／夜间外观、右上角快速切换、跟随 Windows 系统主题，选择自动保存。
- 可选对话全文搜索，默认关闭；当前正文索引支持 Codex 和 Claude Code，只索引用户与 Agent 消息。其他三个来源目前支持元数据搜索。
- Codex 桌面对话使用注册的 `codex://threads/...` 链接；Claude 本地桌面对话要求有效的本地会话 ID 和 `claude://` 协议。打开请求成功不等于能证明客户端已经选中了目标对话。
- **原终端标签/分屏精确定位，以及从当前前台窗口直接订阅，尚未在此版本实现。** 可以从列表订阅，或使用终端恢复入口。
- 无本地记录、无 Hook 的纯云端会话不能可靠监测。客户端未提供授权事件时，单靠记录也无法补齐所有授权状态。
- 本轮停止显示为“本轮结束”；只有明确 `completed` 事件才显示“已完成”。没有可靠证据时不按超时猜完成。
- 当前扫描最近 1000 份本地记录，数据库会话保留最多 2000 条用于列表展示；本机 Codex 目录元数据也会合并进列表。

| 来源 | 状态来源 | 提醒能力与导航边界 |
|---|---|---|
| Codex | 本地 rollout / Hook | 支持本地请求跟踪；尝试 `codex://threads/...` 或 CLI 恢复 |
| Claude Code | 本地 JSONL / Hook | 支持本地提问和授权；桌面映射或 CLI 恢复 |
| Cursor | 本地 composer 元数据、JSONL、观察 Hook | 可识别问题、阻塞用户决定、失败与中断，不能保证区分所有审批；唤起 Cursor 并复制 ID |
| DeepSeek Harness | `.dsh` 原生 JSONL / 拼接 Zstandard 日志 | 按真实序号和时间跟踪回合、提问/回答、授权/决定、错误/额度/中断；唤起应用并复制 ID |
| WorkBuddy | `workbuddy.db` / 项目 JSONL | 支持 AskUserQuestion、匹配回答与数据库异常；原生授权弹窗未持久化，无法可靠监测；尝试 `workbuddy://chat/<id>` |

首次订阅和重启后恢复历史状态不会补发历史通知。新的待处理请求按真实事件去重；停止一轮执行不清除尚未回答的问题。新来源读取失败会在设置中显示具体错误，不阻止其他客户端采集。

## 数据与卸载

应用数据：`%APPDATA%\AgentInboxWindows`。为兼容 0.3.0 的订阅、通知、Hook 与统计配置，AgentDeck 1.0.2 继续使用这条数据路径。这里包含订阅数据库、状态、通知队列、缓存、搜索索引、Hook 启动程序和日志。客户端对话文件只读；没有上传服务，也不需要新的 API Key。使用统计与自定义会话扫描只提取配置中映射的时间戳和会话元数据，不上传、不复制正文，也不修改源文件；扫描缓存随应用进程释放。

来源默认读取 `%USERPROFILE%\.codex` 和 `%USERPROFILE%\.claude`；支持继承 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`AGENT_INBOX_CLAUDE_DESKTOP_ROOT`。Claude 桌面数据默认探测 `%APPDATA%\Claude\claude-code-sessions`，版本差异可通过上述环境变量指定。

新增来源目录：Cursor 的 `%USERPROFILE%\.cursor` 与 `%APPDATA%\Cursor\User`；DeepSeek Harness 的 `%USERPROFILE%\.dsh`；WorkBuddy 的 `%USERPROFILE%\.workbuddy`。可分别使用 `AGENT_INBOX_CURSOR_ROOT`、`AGENT_INBOX_CURSOR_USER_DATA`、`AGENT_INBOX_DSH_ROOT`、`AGENT_INBOX_WORKBUDDY_ROOT` 指定其他位置。外部数据库始终以只读方式打开；压缩日志只在本机解压，不修改源文件。

Hook 接入前保留带时间戳的配置备份；“移除 Hook”只移除此应用的条目，并保留其他配置。移动便携应用目录后请先运行应用一次，更新 Hook 启动路径；启用了开机启动时请关闭再开启以更新路径。

卸载顺序：在设置中移除已接入的 Hook、关闭开机启动 → 从托盘退出 → 删除应用目录和开始菜单的 AgentDeck 快捷方式。需要清理订阅与索引时，可手动删除应用数据目录。关闭全文搜索本身不会删除已有索引。

## 开发

```powershell
npm ci
npx install-electron
npm test
npm run typecheck
npm start
npm run dist
```

`dist` 输出到此工作区的 `work/windows-package`；构建脚本使用 esbuild。核心来自上游 main / 7ad0359。Windows 界面、IPC 桥、托盘、系统通知、PowerShell 启动器和路径适配在 `desktop/` 与核心相应文件中。

内部 Hook CLI 仍位于 `build/agent-inbox.mjs`，文件名与环境变量保留旧名以兼容已有 Hook。它支持 `event`、`hook`、`list` 等诊断命令。Windows Hook 通过打包的 Electron Node 模式执行，无需系统 Node；事件只入队，通知由托盘应用投递。应用完全退出期间 Hook 可保存状态，但不会即时显示通知。

## 许可证

MIT，保留上游 Copyright (c) 2026 0xFANGO，见 LICENSE。SQLite 是公有领域软件；Electron / Chromium 许可证随可运行应用附带。Codex/OpenAI、Claude 标识沿用上游 SVG；Cursor、DeepSeek Harness、WorkBuddy 图标取自本机已安装应用的原始资源。品牌权利归各自所有者，用于识别接入来源。来源说明见 resources/THIRD-PARTY-NOTICES.txt。
