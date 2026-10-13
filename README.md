# Coda 插件

Coda 的公开插件仓库，和给插件作者用的契约检查。

Coda 是一个多 Agent 客户端（Mac、iPhone 与运行在你机器上的后端）。Agent 与资源页的面板都以插件接入：
插件是一个目录，清单就是它的 `package.json`（`contributes.agents`、`contributes.panels` 等，照 VS Code 扩展的写法）；
Agent 讲 [ACP](https://agentclientprotocol.com)，外加 Coda 的等待项登记 `_coda/wait`，见 [接入协议](docs/agent-protocol.md)。

```
plugins/cursor/      Cursor：只有清单，运行机上的 Cursor CLI 自己讲 ACP
templates/agent/     最小的 Agent 插件：手写 ACP 的回声 Agent，演示等待项与自主轮次
templates/panel/     最小的面板插件：一张卡片、一条进度条、一个按钮
bin/、check/         契约检查（仓库根的 package.json 就是它，@coda-console/plugin-check）
docs/agent-protocol.md   Coda 接入协议正文的公开副本
```

## 在 Coda 里安装

「设置 › 插件 › 从仓库添加…」：

1. **仓库**填 `coda-console/coda-plugins`（或 `https://github.com/coda-console/coda-plugins`）；**版本**留空是默认分支，也可以填分支、标签或完整的提交号。
2. **读取**：Coda 拉取那个提交，把仓库根与两层以内 `package.json` 带 `contributes` 的目录各列成一个插件——这个仓库里是 `plugins/cursor`、`templates/agent`、`templates/panel`。
3. 选一个，确认里逐条列出它会运行的命令（Agent 的 `command`、面板的命令与动作），确认就是批准：这些命令以你的账户在空间里每台机器上运行，Coda 不做隔离，只装你信任的来源。

**Coda 只认提交**：安装时钉在读取到的那个提交上，每台机器各自取同一个提交。「检查更新」用记下的仓库与版本再读一次，提交变了才有更新；
上一个提交留着，可以回退。清单里的 `version` 只作显示，不参与比较——改了行为就把它加一，方便人看。这个仓库不打标签、不发 npm、不发 release。

自己的插件可以放在自己的仓库里（单插件仓库让仓库根就是插件目录），在自己的 Mac 上试的时候，仓库填本机仓库的绝对路径即可：Coda 读的是**提交**，没提交的改动它看不到。

## 写一个插件

从模板开始：把 `templates/agent` 或 `templates/panel` 复制成自己的目录，改掉 `name`（插件 ID）与 Agent 的 `id`。

**清单**（`package.json`）

- `name` 是插件 ID：小写字母、数字和 `-`，以字母开头，至多 40 个字符；不能与 Coda 内置插件同名（`claude`、`codex`、`grok`、`kimi`、`opencode`、`review` 等，完整列表见 `check/coda.mjs`）。
- `displayName`、`description`、`version` 显示在安装确认与插件页。
- `contributes` 只能有 Coda 认识的贡献：`agents`、`panels`、`configuration`、`capabilities`、`instructions`、`extensionPoints`、`extensions`、`groups`；读不懂的键一律报错，不会被悄悄忽略。

**从仓库安装的限制**：不能带 npm 依赖（`dependencies`、`optionalDependencies` 不为空就装不了）；不能有符号链接或子模块；整个目录不超过 10 MiB；
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

Agent 进程的环境是会话的环境再加：`CODA_NODE`（Coda 后端自己的 Node，插件自带的入口用它运行，不在 `PATH` 上）、`CODA_PLUGIN_PATH`（插件目录，从仓库装的是它钉住的版本目录）、
`CODA_PLUGIN_STATE`（插件在这台机器上的状态目录，跨会话、跨版本保留）、`CODA_PLUGIN_EXTENSIONS`（别的插件接在它扩展点上的东西，没有就不设）。
插件自带的入口只能用插件目录里的代码与 Node 自带的模块。

照 [接入协议](docs/agent-protocol.md) 实现，另外几条容易漏的：

- 标准输出只写 JSON-RPC，一行一条；日志写标准错误（Coda 不读它）。请求 ID 是字符串。
- `session/new` 要报当前模型：`configOptions` 里 `category: "model"` 的那一项的 `currentValue`（或 `models.currentModelId`）。Coda 每轮开始前核对，没有就不发这一轮。
- 没登录时在 `initialize`、`session/new` 或 `session/load` 回 -32000，Coda 提示用户去登录。
- `session/cancel` 后 30 秒内结束这一轮（`stopReason: "cancelled"`），否则 Coda 关掉它的进程组。
- 一轮之外的审批与提问 Coda 一律拒绝，除非正有等待项在 `handling`（那是一轮自主轮次）。

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
命令的环境有 `CODA_PLUGIN_PATH`、`CODA_PLUGIN_STATE`、`CODA_PLUGIN_SETTINGS`（插件设置的 JSON），`PATH` 最前面是 Coda 后端的 `node`；动作另有 `CODA_PANEL_ARGS`（按钮的 `args`）。
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
| 清单（总是） | 不要 | `package.json` 读得懂、ID 合法且不与内置的撞；每个 Agent 字段齐全、`command` 一行、图标是不超过 32 KiB 的 PDF；面板声明；从仓库安装的限制 |
| 握手（默认） | 不要 | `sh -c` 启动 `command`（环境给 `CODA_NODE`、`CODA_PLUGIN_PATH`、临时的 `CODA_PLUGIN_STATE`），发与 Coda 相同的 `initialize`，要求 `protocolVersion` 为 1；`session/new` 给出会话与当前模型，回 -32000 记为未登录、跳过后面的检查（不算失败）；关标准输入后 5 秒内退出。面板读一次，输出合格式 |
| 一轮（`--live`） | 要 | 发一轮提示词（默认「只回复 ok」）收到 `stopReason`；每条 `session/update` 过 ACP SDK 的 schema；`_coda/wait` 按 Coda 的 `validWait` 与协议的规则核对；审批与提问一律回拒绝，在一轮之外发来的算失败；再发一轮并 `session/cancel`，30 秒内要结束；有自主轮次的也取消一次；声明 `loadSession` 的，新开进程 `session/load` 要成功 |

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
npm test                                   # node --test 'test/**/*.test.mjs'：两个模板跑全三级，加故意讲错协议的假 Agent
node bin/check.mjs templates/agent --live --prompt "wait 看看自主轮次"
```

唯一的依赖是 `@agentclientprotocol/sdk`，版本与 Coda 后端相同（1.4.0）；`zod` 是它的 peer 依赖。

## 许可

MIT，见 [LICENSE](LICENSE)。各插件的品牌图形归各自权利人所有，来源写在插件的 `icons/README.md`。
