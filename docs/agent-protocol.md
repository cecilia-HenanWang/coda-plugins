<!--
  副本：由 scripts/sync-protocol.mjs 从 Coda 主仓库的 docs/agent-protocol.md 同步，不要直接改；改协议先改 Coda 的正文，再同步。
  coda-commit: 2ba612048c7acec63969c3ac91264ed437cb320f
  acp-protocol-version: 1
  acp-sdk: 1.4.0
  body-sha256: 295d74dcd759e352c37c72b771d852d468abf8159cdee746a7d8408469346629
-->
# Agent 接入协议

> 这是 Coda 接入协议正文的公开副本（Coda 主仓库不公开），同步自它的 docs/agent-protocol.md。指向 Coda 其他文档的链接在副本里只留文字。

Coda 用 [ACP](https://agentclientprotocol.com)（Agent Client Protocol）接 Agent，外加一条扩展：Agent 把自己在等的东西登记给 Coda
（等待项登记，`_coda/wait`）。本文是这份协议的唯一正文，写给要让一个 Agent（比如 Cursor 的）接入 Coda 的人：照它实现，
Coda 就知道这个 Agent 在一轮之外还有什么没做完，不把会话当成静止，把它处理这些东西时的输出、审批和提问放进正确的一轮，
并把结果交回正确的调用。产品上这些规则的来由见会话行为契约与完成唤醒契约。

## ACP 部分

Coda 是 ACP 的客户端。每个会话的 Agent 进程由一个会话托管进程持有，经标准输入输出说 JSON-RPC；
后端重启只断开连接，进程照跑，后端不在期间 Agent 发来的消息记在托管日志里，新后端按顺序续读，每条只处理一次。

| 方法 | 方向 | Coda 怎么用 |
| --- | --- | --- |
| `initialize` | Coda → Agent | 握手。`clientCapabilities` 带 `elicitation.form`、`elicitation.url`、`session.compaction`、`session.configOptions.boolean` 与 `_meta.coda.waits`（见[能力协商](#能力协商)） |
| `session/new`、`session/load` | Coda → Agent | 新建或恢复原生会话，会话 ID 由 Agent 给；Agent 声明 `loadSession` 才会被要求恢复。恢复期间重放的历史 Coda 不收（它有自己的），只收命令与标题 |
| `session/prompt` | Coda → Agent | 一轮：Coda 送出用户的消息或它自己合成的输入（子任务结果等），Agent 回复 `stopReason` 即本轮结束 |
| `session/cancel` | Coda → Agent | 停止：本轮在进行时取消本轮；Agent 在一轮之外处理等待项（`handling`）时，停止处理 |
| `session/set_config_option`、`session/set_mode`、`session/set_model` | Coda → Agent | 模型、推理强度与模式 |
| `session/update` | Agent → Coda | 回复、思考、工具调用、计划、用量、可用命令、会话信息；只收本会话与它的子会话的 |
| `session/request_permission`、`elicitation/create`（`mode: form` 或 `mode: url`） | Agent → Coda | 审批与提问，作为卡片交给用户；只在一轮里受理（见[规则](#规则)第 3 条） |
| `$/cancel_request` | Agent → Coda | 撤回它发出、还没得到回答的审批或提问：卡片失效，Coda 回 `cancelled`（表单回 `cancel`），之后用户的回答不再转交 |

ACP 只允许在一轮（`session/prompt`）进行时交互。Agent 在两轮之间发来的审批或提问，Coda 拒绝（审批回 `cancelled`，表单回 `cancel`）
并在会话里记一条说明；它正在处理某个等待项时例外，那时请求属于处理它的那一轮。两轮之间的 `session/update` 照收。

- **审批**：选项由 Agent 列出，Coda 原样展示，用户选哪个回哪个；授权的范围、对象与期限写在选项名里，Coda 不另分栏、不自行扩展授权。
- **表单**：`requestedSchema` 是标准 JSON Schema，Coda 按它展示并校验回答；单选、多选用
  `enum` 或 `oneOf`/`anyOf` 的 `{const, title}`，不认私有键。
- **链接**（`mode: url`）：带 `url` 与 `elicitationId`，没有要填的字段；Coda 展示链接，用户打开、办完后确认，回 `{action}`（`accept`、`decline` 或 `cancel`）。
- **设置**：会话设置里选了的模型、推理强度与模式，每轮开始前设给 Agent；没选的保持会话现状。模型或推理强度的选择型配置项里，
  可以有一项带 `_meta.coda.default: true`，表示交给 Agent 自己的默认：会话设置里没选时，Coda 把配置项切回这一项。这一项不进模型或强度的列表，
  当前值是它时按没有设置显示。
- **其他配置项**：模型、推理强度与模式之外的配置项，Coda 原样列给用户：选择型是一组选项，开关型（`type: boolean`）是一个开关；Coda 在 `initialize` 的
  `clientCapabilities.session.configOptions.boolean` 里声明接受开关型。会话设置里按配置项 ID 给的值，每轮开始前设给 Agent；当前模型没有这一项就不设。
  Coda 设过、会话设置里又去掉的（用户选回「Agent 默认」），切回 Agent 标了 `_meta.coda.default` 的那一项，没标就切回 Coda 第一次设它之前、
  同一模型下 Agent 报的值，两样都不知道就不改。Agent 自己改的 Coda 不去改回；用户在会话里用命令改的（如 Codex 的 `/fast`）记进会话设置。名字与说明照 Agent 给的显示。
- **未登录**：Agent 在 `initialize`、`session/new` 或 `session/load` 回错误 -32000（ACP 的 `auth_required`）时，Coda 告诉用户这个 Agent 未登录，
  到「资源」里添加（面板的登录）；Coda 不调用 `authenticate`，也不按错误文字猜。

## 等待项登记

`session/prompt` 的回复只结束一轮。一轮之后 Agent 还可能有东西没做完：放到后台的命令、派出去的子 Agent、到点会叫醒它的定时。
ACP 不说这些，Coda 看不见就会认为会话已经静止：宣告完成、把子会话的结果交回父会话、回收空闲进程。
等待项登记让 Agent 把这些东西告诉 Coda，每一样一个等待项，从开始等到结束。

### 能力协商

- Coda 在 `initialize` 的 `clientCapabilities` 里总是带 `_meta.coda.waits: {}`。没看到它的客户端不认识这条扩展，Agent 不应对它发 `_coda/wait`。
- Agent 在 `initialize` 结果的 `agentCapabilities` 里带 `_meta.coda.waits: {}`，表示它会登记。这只是声明：Coda 把它记在托管握手里，
  健康检查（`GET /v1/health` 的会话项 `waits`）报出来；不声明的 Agent 发来的 `_coda/wait` 也照收。

```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"_meta":{"coda":{"waits":{}}}}}}
```

### `_coda/wait`

Agent 发给 Coda 的通知（没有 `id`，不回复），和 `session/update` 走同一个顺序：说在前面的先处理。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 它属于哪个会话：本会话，或 Coda 已经认得的子会话（之前某个等待项的 `childSessionId`）。别的会话的一律丢弃 |
| `waitId` | 是 | Agent 自己取的身份，同一会话内不重复，至多 200 字 |
| `state` | 是 | `waiting`、`handling`、`done`、`failed`、`cancelled`，见下 |
| `kind` | 否 | `task`（默认）、`subagent`、`timer`，或别的词（按 `task` 算）；第一次报告时定下，之后可以省略，改了也按第一次的算 |
| `title` | 否 | 给人看的名字，至多 500 字 |
| `detail` | 否 | 说明：任务在做什么，定时按什么计划触发；至多 4000 字 |
| `stoppable` | 否 | Coda 能不能经 [`_coda/wait/stop`](#_codawaitstop) 停它，默认不能 |
| `childSessionId` | `subagent` 要 | 子 Agent 自己的会话。从此这个会话的 `session/update`、审批与提问也收，记为这个子 Agent 的 |
| `model` | 否 | 子 Agent 的实际模型 |
| `outputFile` | 否 | 任务输出所在的文件，Coda 处置拖住会话的后台命令时读它的末尾与持有它的进程 |
| `toolCallId` | 否 | 启动它的那次工具调用，同一会话里的 `toolCallId`：任务详情与处置卡片据此显示启动命令；它没结束时，那次调用缺结果也不被收束为结果未确认 |
| `at` | `timer` 要 | 下次触发的时刻，ISO 8601 |
| `recurring` | 否 | 定时是否反复触发 |

缺必填字段、`state` 不在上表、字段过长或 `at` 读不出时间的，整条丢弃，不报错。之后的报告只需带变了的字段，没带的保持原样。

| `state` | 含义 |
| --- | --- |
| `waiting` | 在等，Agent 没在处理它 |
| `handling` | Agent 正在处理它：后台命令结束了、子 Agent 交回了、定时到点了，Agent 据此干活。见[规则](#规则)第 3 条 |
| `done`、`failed`、`cancelled` | 结束了：做完、失败、被停止。终态是最终的，同一个 `waitId` 之后再说什么都不算；第一次报告就是终态的不登记 |

`kind` 决定 Coda 把它当成什么，不只是怎么显示：

| `kind` | Coda 当它是 | 显示 | 会话的事实 |
| --- | --- | --- | --- |
| `task` 与其他词 | 后台命令 | 会话历史里的后台任务卡片、底部的未结束任务、后台任务列表；`stoppable` 时有停止按钮；拖住会话太久时生命周期流程可以停掉或放行它（后台任务处置） | `background`，并列在 `backgroundCommands` |
| `subagent` | 委派 | 委派清单里的一项（`kind: task`），点开是它的过程视图，子会话的输出都归它 | `background`，不在 `backgroundCommands` |
| `timer` | 定时唤醒 | 会话底部的定时一行（计划、是否反复）；不进历史 | `scheduled`，不算 `background` |

```json
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"build-1","kind":"task","state":"waiting","title":"构建","detail":"npm run build","stoppable":true,"outputFile":"/tmp/build-1.log"}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"build-1","state":"handling"}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"build-1","state":"done"}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"review","kind":"subagent","state":"waiting","title":"评审改动","childSessionId":"s1/review","stoppable":true}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"hourly","kind":"timer","state":"waiting","title":"每小时看一次 CI","at":"2026-10-12T10:00:00Z","recurring":true}}
```

### `_coda/wait/stop`

Coda 发给 Agent 的请求，参数 `{ "sessionId": …, "waitId": … }`，Agent 回 `{}`。只对声明了 `stoppable` 的等待项发：
用户点了任务或子 Agent 的停止、生命周期流程停掉拖住会话的后台命令（`stop-background`）、父会话取消这次调用时它树下的等待项。
回复只表示收到；Coda 不当它已经停了，直到 Agent 随后用 `_coda/wait` 报它结束（通常是 `cancelled`）。

### 规则

1. **起因**：等待项的起因是登记它时正在进行的那一轮；没有轮次在进行时起因未知（见起因）。
   它只挡起因沿链走得到的那次调用：父会话派来的那一轮里登记的，挡那次调用；用户直接发的消息那一轮里登记的，不挡父会话的调用；
   起因未知的挡所有调用。
2. **静止**：会话有没结束的等待项（定时也算）就不静止：不宣告完成，它树下的调用不交回，进程不被空闲回收，`!` 命令不执行。
3. **处理（`handling`）**：Agent 在一轮之外处理等待项时，Coda 为它开一轮自主轮次。这一轮的起因是最先进入 `handling` 的那一项，
   所以这一轮说的话随那一项的调用交回。这一轮进行中别的项进入 `handling`，并入这一轮，起因不变。所有项都离开 `handling`
   （回到 `waiting`，或结束）时这一轮结束。这一轮里 Agent 的输出、审批与提问都归它，子会话发来的也一样；用户这时发的消息排队，等这一轮结束再送。
   在 Coda 发起的一轮（`session/prompt`）进行中进入 `handling` 的，算在那一轮里；那一轮结束时还有项在 `handling`，接着开一轮自主轮次。
   用户停止这一轮时，Coda 对本会话发 `session/cancel`：Agent 应停止处理，把这些项改回 `waiting` 或报结束；这一轮随之结束，
   因为分不清停止和做完谁先到，结果记为未知。30 秒内这一轮还没结束，Coda 关掉托管连接与它的进程组，结果未知，不自动重跑。
4. **定时**：`kind: timer` 带下次触发的 `at` 与 `recurring`。到点时报 `handling`，处理完反复的回到 `waiting`（可以带新的 `at`），
   一次性的报 `done`。`at` 是触发时刻，不是期限：到点没报不算过期。父会话取消这次调用时，它树下 `stoppable` 的定时经 `_coda/wait/stop` 停掉，
   其余的调用不再等，Coda 不删除它们，并如实告诉父会话留下了哪几个（要删得请 Agent 自己删）。
5. **子会话与继续**：`childSessionId` 让 Coda 认得那个会话。子 Agent 结束后，Agent 以新的 `waitId`、同一个 `childSessionId` 再登记一次，
   就是继续同一个子 Agent：委派清单里还是那一项，多一次运行，这一次的起因是再登记时进行的那一轮。
6. **放行**：生命周期流程放行（`release-background`）一个后台命令后，会话不再等它，它的等待项以 `released` 结束；
   命令照跑，卡片照常更新，之后再报 `waiting` 也不会让会话重新等它。
7. **进程结束**：Agent 进程结束（崩溃、停止超时被关、空闲回收、机器重启），它所有没结束的等待项以 `disconnected` 结束，结果未知，
   Coda 不重放。后端重启而托管还在时一切照旧：等待项、`handling` 的那一轮都接回，后端不在期间的 `_coda/wait` 从托管日志续读，各只算一次。
8. **会话加载中**：`session/new`、`session/load` 期间发来的 `_coda/wait` 先存着，会话身份确定后按原顺序处理，只收本会话与这些登记里公告的子会话。
   所以 Agent 恢复会话时可以把还在等的东西重报一遍：同一个 `waitId` 再报 `waiting` 不会多登记一项。

## 内置 Agent 的入口进程

Coda 自带的 Agent 都是内置插件（`backend/src/resources/plugins/<插件>/`，清单见插件：Agent），照本协议接入：
各家要做的特殊处理在它自己的入口进程里（插件的 `agent/`），入口不引用 Coda 后端的模块。怎么启动写在清单的 `command` 里：
插件自带的入口由 Coda 的 Node（`CODA_NODE`）从运行时副本里的插件目录运行，其余是运行机上的命令。
从仓库安装的插件，入口从它的版本目录运行，只能用插件目录里的代码与 Node 自带的模块。
Coda MCP 服务器的 `instructions` 至多 16384 字，入口按这个长度告诉 Agent 别截断。

| Agent | 入口 | 它在协议之外替 Agent 做的 |
| --- | --- | --- |
| Codex（插件 `codex`） | `agent/entry.mjs`：在同一进程里运行锁定版本的 codex-acp，加载 Coda 的源码补丁（适配器一变就启动失败） | 向 codex-acp 声明 JetBrains AIR 的 `nativeSubagentSessions` 与 `asyncTasks`，把 AIR 报的子 Agent 与转入后台的命令翻成 `_coda/wait`：命令带 `toolCallId`，codex-acp 说能停的经 AIR 的停止（发给根会话）停；子 Agent 在 codex-acp 说能取消时经取消它的会话停。codex-acp 把继续的子 Agent 叫 `X:generation:N`，对 Coda 一律是 `X`，每次运行一个新的 `waitId`。会话默认以只读模式开始（`INITIAL_AGENT_MODE`，运行机设了就用它的）；Coda 选的账号经账号桥接上。Codex 没有自主轮次，不报 `handling` |
| Claude（插件 `claude`，Agent `claude-sdk`） | `agent/entry.mjs`：Coda 基于 Claude Agent SDK 写的 ACP Agent，一个进程一个 SDK 会话；SDK 是资源页选的版本（`CODA_CLAUDE_SDK_ENTRY`） | 会话 ID 由入口生成；模型一律是具体 ID（SDK 列出的 `resolvedModel` 加上下文变体，不接受别名）。后台任务、子 Agent 与 Stop hook 列出的定时唤醒报成 `_coda/wait`：子 Agent 的会话是启动它的工具调用 ID，SendMessage 续聊是同一会话的新一次运行；没有轮次时结束的任务，等一轮接手或会话空闲才了结。Claude 自己开始的一轮，按开场消息指名的、已结束的任务、唯一到点的定时、自造的「Claude 自主继续」依次认定在处理什么，在任何输出与请求之前报 `handling`。审批的选项是仅允许本次、每条建议规则一个 `allow_always`、拒绝；SDK 不再等回答时发 `$/cancel_request`。MCP 服务器的表单原样转来，链接用 `mode: url`。额度写进插件状态目录的 `limits.json`（内置插件：Claude），标题经 `session_info_update` 报 |
| Kimi（插件 `kimi`） | `agent/entry.mjs`：把 `kimi acp` 作为子进程，在两者之间逐条转发 | 读 Kimi 的会话文件，把入口启动之后开始的后台命令与子 Agent 报成 `_coda/wait`（子 Agent 的会话是它的 agentId，过程报成那个会话的 `session/update`；按运行先后交付登记、过程与了结，同一子 Agent 的下一次运行等上一次了结才报，从而接着用同一张卡片）；结果要交给主 Agent 的从结束起报 `handling`，主 Agent 在那之后结束一轮时了结。不能停，不带 `toolCallId`。只认 Kimi CLI 2.1.1 的文件布局，见会话行为契约 |
| Grok、OpenCode（插件 `grok`、`opencode`） | 运行机上的 `grok agent --no-leader stdio`（先找 `~/.grok/bin/grok`）、`opencode acp` | 无，原样 ACP，不登记等待项 |

Claude 的提问（AskUserQuestion）是这样一张表单：第 i 个问题是必填字段 `q{i}`，`title` 是问题、`description` 是它的标题；单选为
`type: string` 加 `oneOf: [{const, title}]`，多选为 `type: array`、`items.anyOf`、`minItems: 1`。每个问题的选项最后多一个
`{"const": "coda:other", "title": "其他（写在下面）"}`，另有可选字段 `q{i}_other`（`type: string`）写其他的内容：表单说不出「两个字段至少填一个」，
所以用这个选项表示答案在旁边。

```json
{"type":"object","required":["q0"],"properties":{
  "q0":{"type":"string","title":"用哪种方案？","description":"方案","oneOf":[{"const":"小改","title":"小改 — 只动接口"},{"const":"coda:other","title":"其他（写在下面）"}]},
  "q0_other":{"type":"string","title":"其他"}}}
```
