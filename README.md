# Coda 插件

Coda 的公开插件仓库，和给插件作者用的契约检查。Coda 自带的 Agent 插件（Codex、Claude、Kimi、Grok、OpenCode 与 Codex 多账号）也在这里维护。

Coda 是一个多 Agent 客户端（Mac、iPhone 与运行在你机器上的后端）。Agent 与资源页的面板都以插件接入：
插件是一个目录，清单就是它的 `package.json`（`contributes.agents`、`contributes.panels` 等，照 VS Code 扩展的写法）；
Agent 讲 [ACP](https://agentclientprotocol.com)，外加 Coda 的 Agent 活动报告 `_coda/wait`，见 [接入协议](docs/agent-protocol.md)。

```
plugins/codex/           Codex：入口在同一进程里运行锁定版本的 codex-acp（npm 依赖），面板「Codex」
plugins/claude/          Claude SDK：基于 Claude Agent SDK 的 ACP 入口（npm 依赖），面板「Claude」
plugins/kimi/            Kimi Code：在运行机的 kimi acp 与 Coda 之间转发，面板「Kimi」
plugins/grok/            Grok：只有清单，运行机上的 Grok CLI 自己讲 ACP，面板「Grok」
plugins/opencode/        OpenCode：只有清单，运行机上的 opencode acp
plugins/codex-accounts/  Codex 多账号：管理登录、自动续期与账号选择，接管 Codex 额度面板
plugins/cursor/          Cursor：只有清单，运行机上的 Cursor CLI 自己讲 ACP
templates/agent/         最小的 Agent 插件：手写 ACP 的回声 Agent，演示 Agent 活动与自主轮次
templates/panel/         最小的面板插件：一张卡片、一条进度条、一个按钮
bin/、check/             契约检查（仓库根的 package.json 就是它，@coda-console/plugin-check）
test/                    检查包的测试；test/plugins/ 是各插件的测试（插件目录里只放运行要用的文件）
docs/agent-protocol.md   Coda 接入协议正文的公开副本
```

## Coda 自带的插件

`codex`、`claude`、`kimi`、`grok`、`opencode`、`codex-accounts` 是 Coda 内置的插件，源码从此在这里维护。
Coda 仓库里的 `backend/src/resources/plugins/<id>/` 是本仓库**某个提交的只读副本**：Coda 的同步脚本按它的锁文件
（记着本仓库的提交与每个目录的树哈希）把那个提交里的 `plugins/<id>` 原样复制过去，新机器、离线首启都带着它们。

- **改它们先在这里提 PR、合并**，再在 Coda 里同步到那个提交；不要直接改 Coda 里的副本（Coda 的测试会核对副本与锁文件一致）。
- Coda 的「检查更新」可以从这里装同一插件的新提交，盖过内置副本；只有本仓库的 `plugins/<id>` 这个来源能用这些名字。
- 测的是插件自己代码的用例在 `test/plugins/<id>/`；把 Coda 与入口合在一起测的（启动 Coda 后端、写进 Coda 的存储）留在 Coda，对副本跑。

| 插件 | npm 依赖（与 Coda 后端同版本） | 运行机上另要 |
| --- | --- | --- |
| `codex` | `@agentclientprotocol/codex-acp` 1.12.0、`@openai/codex` 0.162.1；`overrides` 让 codex-acp 用同一个 `@openai/codex` | — |
| `claude` | `@agentclientprotocol/sdk` 1.4.0、`@anthropic-ai/claude-agent-sdk` 0.3.296（平台二进制是 SDK 自己的可选依赖） | — |
| `codex-accounts` | `proper-lockfile` 4.1.2；用依赖插件 `codex` 的 Codex CLI | 无；依赖 `codex` 插件 |
| `kimi` | 无 | Kimi CLI（面板可从 Coda 安装、登录） |
| `grok` | 无 | Grok CLI（面板可从 Coda 安装、登录） |
| `opencode` | 无 | 已安装并登录的 `opencode` |

带依赖的插件各有自己的 `package-lock.json`（`node_modules` 不提交）；Coda 在插件的版本目录里 `npm ci` 装它们，
这几个插件不是本仓库根的 npm workspaces（根包是契约检查，装它不该带上 Codex、Claude 的平台二进制）。

### Codex 账号与额度

`codex` 与 `codex-accounts` 是两个独立插件：Codex Agent 由 Coda 默认安装；多账号插件需用户在「设置 › 插件」主动安装。
仅随 Coda 提供插件目录不代表启用。未安装多账号插件时保留 Codex 原生登录与额度看板，安装后由多账号插件接管，卸载后恢复。

`codex-accounts` 2.0.0 自己管理账号，不需要预装账号管理器或 Python。安装时 Coda 安装它的 npm 依赖和
`codex` 插件；本版接管额度、登录入口和续期通知的配套入口是 `codex` 1.1.0。已有安装升级时两个插件一起更新，
Coda 内置副本同步时也一起带上这两个目录。

- 首次使用会把运行机 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）里的 ChatGPT 登录导入插件，作为第一个
  普通受控账号并默认选用。原文件保留；之后的凭据、续期与选择都由插件维护，原登录文件后续变化不会替换受控账号。
  只有系统钥匙串里的凭据无法从文件导入，需要在插件中登录一次。
- 没有已有登录时，从「资源 › 添加资源 › Codex 多账号」完成设备码登录。已有账号后，通过面板菜单的「重新登录」
  添加其他账号；登录同一身份会更新其凭据。添加第二个账号不会改变已选账号。
- 接入后「Codex」自带的额度看板隐藏，只显示「Codex 多账号」里的账号额度。原 Codex 登录入口也委托给账号插件，
  避免建立另一套登录；面板中没有「使用本机账号」。卸载账号插件后，Codex 自带看板恢复。
- 每个账号支持选择、查看额度、使用完全重置和移除。选择在新会话和轮次交界处生效；移除已选账号后须重新选择或添加，
  会话不会回退到原登录。首次导入只发生一次，移除的账号不会再次被自动导入。

账号存放于 `CODA_PLUGIN_STATE/accounts/<身份摘要>/auth.json`，目录权限 0700、文件权限 0600。
每个账号有独立的 `CODEX_HOME`，由插件依赖中的 Codex 执行设备码授权及 refresh-token 续期。
跨进程的每账号锁覆盖续期、额度读取、重新登录和移除，避免多个会话同时使用同一个轮换凭据。
会话只通过 `codex/account-source` 的私有管道拿到 access token；refresh token 留在受控登录文件中。
登录存储与续期采用 [Codex 官方认证机制](https://learn.chatgpt.com/docs/auth#credential-storage)。

旧版的 `selection.json` 仍然识别：`native` 转为首次导入的账号；指向其他旧账号的选择保留，并提示在插件中重新登录该账号，
不会悄悄切换。新版不再读取旧外部管理器的账号库，其他账号可直接从插件添加。

`codex/account-source` 的完整进程约定在 `plugins/codex/agent/account-source.mjs`：`selected` 返回身份和名称，
`tokens` 返回该身份的 access token，`refresh: true` 要求续期；无可用选择应返回错误。来源还通过 `--login` 接受
原 Codex 登录入口的委托，并自行提供额度面板。Codex 把自己的依赖目录通过 `CODA_PLUGIN_DEPENDENCIES.codex`
交给来源，来源与面板使用同一份 Codex CLI。

Codex 插件在 ACP 出口把 codex-acp 错误 `data.message`、`data.details` 或字符串 `data` 中的原因补进标准 `error.message`，
详情裁掉两端空白并去重，错误码、请求 ID 与原始 `data` 保留。Coda 和其他 ACP 客户端直接显示 `message` 即可；
这层适配由插件维护，客户端无需理解 codex-acp 的内部错误格式。

### 升级 Agent 的 CLI 与 SDK

Codex 会话、面板与登录用的 Codex CLI 就是 `codex` 插件依赖的 `@openai/codex`；Claude 的是 `claude` 插件依赖的
`@anthropic-ai/claude-agent-sdk`。插件按包名从自己的依赖里找它们，Coda 不另给路径。升级就是改这两个版本：
Dependabot（`.github/dependabot.yml`）每周为它们各开一个 PR，连同 `package-lock.json` 一起改；合并后在 Coda「设置 › 插件」
对该插件点「检查更新」，内置副本随 Coda 同步到新提交。升 `@openai/codex` 时 codex-acp 经 `overrides` 跟着用新版本，
合并前用真实会话跑一轮。

## 在 Coda 里安装

「设置 › 插件 › 从仓库添加…」：

1. **仓库**填 `coda-console/coda-plugins`（或 `https://github.com/coda-console/coda-plugins`）；**版本**留空是默认分支，也可以填分支、标签或完整的提交号。
2. **读取**：Coda 拉取那个提交，把仓库根与两层以内 `package.json` 带 `contributes` 的目录各列成一个插件——这个仓库里是 `plugins/` 下的七个与两个模板（与 Coda 内置同名的六个，要 Coda 支持从同一来源更新内置插件之后才装得上）。
3. 选一个，确认里逐条列出它会运行的命令（Agent 的 `command`、面板的命令与动作），确认就是批准：这些命令以你的账户在空间里每台机器上运行，Coda 不做隔离，只装你信任的来源。

**Coda 只认提交**：安装时钉在读取到的那个提交上，每台机器各自取同一个提交。「检查更新」用记下的仓库与版本再读一次，提交变了才有更新；
上一个提交留着，可以回退。清单里的 `version` 只作显示，不参与比较——改了行为就把它加一，方便人看。这个仓库不打标签、不发 npm、不发 release。

自己的插件可以放在自己的仓库里（单插件仓库让仓库根就是插件目录），在自己的 Mac 上试的时候，仓库填本机仓库的绝对路径即可：Coda 读的是**提交**，没提交的改动它看不到。

## 写一个插件

从模板开始：把 `templates/agent` 或 `templates/panel` 复制成自己的目录，改掉 `name`（插件 ID）与 Agent 的 `id`。

**清单**（`package.json`）

- `name` 是插件 ID：小写字母、数字和 `-`，以字母开头，至多 40 个字符；不能与 Coda 内置插件同名（`claude`、`codex`、`grok`、`kimi`、`opencode`、`review` 等，完整列表见 `check/coda.mjs`）。
- `displayName`、`description`、`version` 显示在安装确认与插件页。
- `contributes` 只能有 Coda 认识的贡献：`agents`、`panels`、`configuration`、`capabilities`、`instructions`、`extensionPoints`、`extensions`、`groups`、`commands`；读不懂的键一律报错，不会被悄悄忽略。

**从仓库安装的限制**：带 npm 依赖（`dependencies`、`optionalDependencies`）就要把 `package-lock.json` 一起提交，Coda 在插件的版本目录里
`npm ci`（较早的 Coda 不收带 npm 依赖的插件）；不能有符号链接或子模块；整个目录不超过 10 MiB（`node_modules` 不算，也不该提交）；
目录名只用字母、数字和 `._-`，在仓库根下两层以内。

**Agent**（`contributes.agents`，例子见 `templates/agent/package.json`、`plugins/cursor/package.json`）

| 字段 | 内容 |
| --- | --- |
| `id` | Agent ID：小写字母、数字和 `-`，以字母开头，至多 40 个字符；会话按它存，所有插件里不能重复（不能用 `codex`、`claude`、`claude-sdk`、`kimi`、`grok`、`opencode`） |
| `displayName` | 显示名，一行，不超过 40 字 |
| `icon` | `light`：插件目录里的 PDF，不超过 32 KiB；可选 `dark`；`template: true` 表示单色、随文字着色。画布按 256 px 出（iOS 按 96 pt 光栅化、只缩不放） |
| `command` | 启动命令，一行，`sh -c` 运行，以 `exec` 开头，进程就是 Agent 本身 |
| `modes` | 可省：`title`、`unset`、`note` 是模式选择的标题与说明；`auto`、`full` 是这个 Agent 的「自动审批」「全部放行」各是哪个 ACP 模式 |
| `skillsDir`、`configFiles`、`setupHint` | 可省：Agent 在工作副本里找 skills 的目录；它读模型列表的配置文件（变了 Coda 重读）；用不了时给用户的一句话 |

Agent 进程的环境是会话的环境再加插件进程的那组变量（面板与面板的动作、放在会话 `PATH` 上的命令也一样；继承来的同名变量先去掉，一个插件的进程拿不到别的插件的）：
`CODA_NODE`（Coda 后端自己的 Node，插件自带的入口用它运行，不在 Agent 的 `PATH` 上）、`CODA_PLUGIN_PATH`（插件目录，从仓库装的是它钉住的版本目录）、
`CODA_PLUGIN_STATE`（插件在这台机器上的状态目录，跨会话、跨版本保留）、`CODA_PLUGIN_SETTINGS`（插件设置的 JSON）、
`CODA_PLUGIN_EXTENSIONS`（别的插件接在它扩展点上的东西，没有就不设）、`CODA_PLUGIN_DEPENDENCIES`（它依赖的插件的目录，没有就不设）、
`CODA_ARBITER`（`1`：这是它所在实例自己的正式后端；动本机共享的东西前看它）。
插件自带的入口只能用插件目录里的代码、Node 自带的模块与清单里声明的 npm 依赖。

照 [接入协议](docs/agent-protocol.md) 实现，另外几条容易漏的：

- 标准输出只写 JSON-RPC，一行一条；日志写标准错误（Coda 不读它）。请求 ID 是字符串。
- `session/new` 要报当前模型：`configOptions` 里 `category: "model"` 的那一项的 `currentValue`（或 `models.currentModelId`）。Coda 每轮开始前核对，没有就不发这一轮。
- 没登录时在 `initialize`、`session/new` 或 `session/load` 回 -32000，Coda 提示用户去登录。
- `session/cancel` 后 30 秒内结束这一轮（`stopReason: "cancelled"`），否则 Coda 关掉它的进程组。
- Coda 关会话是对 Agent 的进程组发 SIGTERM，0.8 秒后 SIGKILL：收到 SIGTERM 要尽快退出。
- 一轮之外的审批与提问 Coda 一律拒绝，除非正有活动在 `handling`（那是一轮自主轮次）。

**面板**（`contributes.panels`，例子见 `templates/panel`）：`command` 用 `sh -c` 运行，标准输出是 `{ "items": [...] }`：

| 项 | 字段 |
| --- | --- |
| `card` | `title`、可选 `subtitle`、`items`（至多 20 项，不能再放卡片） |
| `meter` | `label`，可选 `value`、`fraction`（0–1，**还剩多少**，不知道就不写）、`note`、`time`（ISO 8601）与 `timeLabel` |
| `stat` | `label`、`value` |
| `markdown` | `text`（不超过 4000 字） |
| `button` | `label`、`action`（须是这个面板声明的动作）、可选 `args`、`disabled`、`confirm` |
| `error` | `text` |

只在打开资源页或点「刷新」时读，30 秒没结束或输出超过 64 KiB 就停下；读不懂的键或类型算这次读取失败。`items` 为空的面板不显示。
命令的环境是后端的环境（不带会话 ID）加上插件进程的那组变量（同上），`PATH` 最前面是 Coda 后端的 `node`；`CODA_GROUPS_STATE` 是这一刻这个后端各并发组的占用与排队
（`{now, groups}`）；动作另有 `CODA_PANEL_ARGS`（按钮的 `args`）。
动作至多跑 10 分钟，成功后 Coda 立即重读面板。

## 契约检查

扮演 Coda 去读一个插件目录：清单照 Coda 的规则读，Agent 照 Coda 的样子启动、说 Coda 说的话，面板照 Coda 的样子读一次。
**权威校验仍是 Coda 的「读取来源」**（「从仓库添加…」里的读取）：检查包的规则抄自 Coda，抄的是哪个提交写在 `check/coda.mjs`，两边不一致时以 Coda 为准。

```sh
npm ci
node bin/check.mjs <插件目录> [--agent <id>] [--manifest] [--live] [--prompt "…"]

# 不克隆，直接从 GitHub 跑（钉一个提交）
npx github:coda-console/coda-plugins#<提交> <插件目录>
```

| 级 | 要不要登录 | 查什么 |
| --- | --- | --- |
| 清单（总是） | 不要 | `package.json` 读得懂、ID 合法且不与内置的撞（本仓库 `plugins/<id>` 里的内置插件除外）；每个 Agent 字段齐全、`command` 一行、图标是不超过 32 KiB 的 PDF；面板、组与命令的声明，Agent、组与命令不与内置插件的撞；从仓库安装的限制，带 npm 依赖要有对得上的 `package-lock.json` |
| 握手（默认） | 不要 | `sh -c` 启动 `command`（环境照 Coda 给插件进程的：`CODA_NODE`、`CODA_PLUGIN_PATH`、临时的 `CODA_PLUGIN_STATE`、设置默认值的 `CODA_PLUGIN_SETTINGS`，依赖的插件在旁边目录里时给 `CODA_PLUGIN_DEPENDENCIES`），发与 Coda 相同的 `initialize`，要求 `protocolVersion` 为 1；`session/new` 给出会话与当前模型，回 -32000 记为未登录、跳过后面的检查（不算失败）；像 Coda 一样对进程组发 SIGTERM，5 秒内要退出（超过 0.8 秒提醒）；另起一个进程，关掉标准输入后 5 秒内不退出只提醒。面板读一次，输出合格式 |
| 一轮（`--live`） | 要 | 发一轮提示词（默认「只回复 ok」）收到 `stopReason`；每条 `session/update` 过 ACP SDK 的 schema；`_coda/wait` 按 Coda 的 `validWait` 与协议的规则核对（子 Agent 不带 `childSessionId`、定时不带 `at` 只提醒）；审批与提问一律回拒绝，在一轮之外发来的算失败；再发一轮并 `session/cancel`，30 秒内要结束，读到取消后还在做事或拖过 5 秒才答复却不回 `cancelled` 算失败（见下）；有自主轮次的也取消一次；声明 `loadSession` 的，新开进程 `session/load` 要成功 |

**取消后的 `stopReason` 怎么判**：检查发 `session/cancel` 时紧跟一个只会得到 -32601 的探测请求（`_codaCheck/barrier`）。Agent 按顺序读，
探测的答复一定写在它读到取消之后，所以本轮的答复与 `session/update` 落在探测答复的前后，就说明它们写出时读没读到取消。
本轮在读到取消后又发了干活的更新（消息、思考、工具、计划），或过了 5 秒才答复，却不回 `cancelled`，算失败——用户按的「停止」没让它停；
答复先于读到取消写出（取消送到前这一轮已经结束），或读到取消时已经做完、随即答复的（如 Codex 做完后等标题时被取消），只记一条说明。

`--manifest` 只查清单（什么也不运行）；`--agent <id>` 只查一个 Agent。退出码：0 通过，1 有失败，2 用法不对。
面板的动作不运行（按钮可能改动东西）；Coda 自己的 MCP 服务器不给（`mcpServers` 为空）。

在自己插件仓库的 CI 里：

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: npx --yes github:coda-console/coda-plugins#<提交> . --live
```

## 协议正文的副本

Coda 主仓库不公开，所以 `docs/agent-protocol.md` 是它 `docs/agent-protocol.md` 的副本，由脚本从检查包规则所抄的那个提交同步，不要直接改：

```sh
node scripts/sync-protocol.mjs --coda <Coda 仓库目录>   # 同步（看着像私有信息的内容会让它停下）
node scripts/sync-protocol.mjs --check                  # CI：副本声明的 Coda 提交、ACP 协议版本、SDK 版本与检查包一致，正文没被手改
```

Coda 改协议时，同一个改动也给这里开 PR：先改 `check/` 里抄来的规则和 `CODA_COMMIT`，再同步副本。

## 开发

```sh
npm ci
node scripts/install-plugins.mjs          # 在每个带 package-lock.json 的插件目录里 npm ci（照 Coda 装版本目录的参数）
npm test                                   # node --test 'test/**/*.test.mjs'：检查包（两个模板跑全三级、故意讲错协议的假 Agent）与各插件的测试
node bin/check.mjs templates/agent --live --prompt "wait 看看自主轮次"
```

检查包唯一的依赖是 `@agentclientprotocol/sdk`，版本与 Coda 后端相同（1.4.0）；`zod` 是它的 peer 依赖。
`test/plugins/` 的测试从插件目录自己的 `node_modules` 找依赖，没装就报错提示先跑 `install-plugins.mjs`；
`test/plugins/contract.test.mjs` 用假的对端（Claude 的假 SDK、Codex 的假 app-server、充当 `kimi acp` 的假 Agent）对真实入口跑检查包的三级，不用登录。
CI 先装各插件的依赖再跑全部测试，`plugins/*` 只查清单：真实的握手与一轮要各家的 CLI 与登录，不在 CI 跑。

## 许可

MIT，见 [LICENSE](LICENSE)。各插件的品牌图形归各自权利人所有，来源写在插件的 `icons/README.md`。

`plugins/codex/agent/` 里的 `relay.mjs`、`titles.mjs`、`network.mjs`、`process-exit.mjs`、`options.mjs`、`subagents.mjs` 在加载时给锁定版本的
[codex-acp](https://github.com/agentclientprotocol/codex-acp)（Apache-2.0，Copyright 2025 JetBrains s.r.o.）打补丁，补丁里含 codex-acp 构建产物的原文片段。
这些片段按 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 使用，许可全文也随 npm 包装在 `node_modules/@agentclientprotocol/codex-acp/LICENSE`；
codex-acp 本身作为 npm 依赖安装，不在本仓库里。
