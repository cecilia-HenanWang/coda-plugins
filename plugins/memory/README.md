# 原生记忆索引

按会话选择额外的 Claude、Codex 原生记忆，复用它们已有的索引和原文。插件只保存可重建的文件元数据，不创建第二份记忆正文，不生成、合并或同步记忆，也不更改原生配置。

## 自动发现来源

通常无需配置路径。会话里调用 `memory_sources`，插件会自动查找 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/memory/` 和 `${CODEX_HOME:-~/.codex}/memories/`。环境变量非空时只用指定位置，不再回退扫描默认位置，也不遍历整个用户目录。发现阶段只枚举目录、文件名、大小与修改时间，不读正文、不写缓存、不自动选中来源；空库也会列出并标记文件数为 0。缺失目录正常略过，其他错误单独返回，不掩盖另一运行时的来源。

候选来源有稳定 ID、原生目录标识 `label`、文件数 `files` 和 `project: null`。不会从 Claude 有损编码的目录名推断项目：用户只需选择候选并确认其项目归属，不必手填目录。首次 `memory_select` 需要 `confirmProject: true` 才能使用归属未确认的 Claude 来源；确认只对当前工具进程有效，不变成持久映射。Codex 是全局库，仍须显式接受跨项目内容。

### 可选：特殊目录与已确认映射

已有配置继续有效，同一路径的自动发现结果会与之去重，保留原来的来源名和用户确认的项目映射。不在上述范围内的目录（例如原生 `autoMemoryDirectory` 自定义路径），或希望持久保存的项目映射，可在插件设置「额外目录与项目映射」补充：来源名、`runtime`（`claude` 或 `codex`）、`project`（可使用该来源的项目绝对目录）与 `path`（原生记忆目录）。配置值的形状是：

```json
{
  "memory.sources": {
    "claude-project": {
      "runtime": "claude",
      "project": "/absolute/path/to/project",
      "path": "/absolute/path/to/claude-project/memory"
    },
    "codex-library": {
      "runtime": "codex",
      "project": "/absolute/path/to/project",
      "path": "/absolute/path/to/codex-home/memories"
    }
  }
}
```

来源始终由用户选择，读取范围为：

| 来源 | 原生目录与读取范围 |
| --- | --- |
| Claude | 通常在 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<项目编码>/memory/`，仅读该目录顶层的 Markdown；`MEMORY.md` 是原生短索引。请从原生 Agent 确认目录，不从编码目录名反推项目。 |
| Codex | 通常在 `${CODEX_HOME:-~/.codex}/memories/`，仅读 `memory_summary.md`、`MEMORY.md` 与 `rollout_summaries/`、`extensions/` 内的 Markdown。不扫描 `raw_memories.md`、会话记录、原始 rollouts 或 skills。 |

配置里的 `project` 是用户声明的映射，输出以 `projectMapping: "user"` 标注，并不是从原生正文自动识别的归属。已映射的项目必须匹配才允许选用，`confirmProject` 不能绕过这个限制；Git worktree、子目录等需要确认实际会话使用的项目路径，插件不会猜测它们属于同一个项目。

Codex 原生库可能包含多个项目，始终标记 `scope: "global"`。配置项目只限制在哪个项目允许选用这个库，不会过滤库中的跨项目内容；用户还须在每次会话选择时明确接受 `includeGlobal: true`。自动发现的 Claude 来源确认后标记 `projectMapping: "session-confirmed"`，自动发现的 Codex 来源标记 `"session-global"`，不宣称原文已按项目过滤。

## 会话中使用

新开或重新加载的会话收到插件说明、memory Skill 与 stdio MCP 工具，但默认不选择来源、不加载记忆正文。用户可以说：「本会话开启额外记忆，使用 claude-project」；Agent 根据已知会话上下文填写当前 Agent ID 和项目，仅在未知时询问。

1. `memory_sources` 自动发现并列出候选来源，同时保留已登记映射；让用户选择，不读正文。
2. `memory_select` 接收当前 `runtime`、`project`、来源名数组 `ids`，按需扫描元数据并加载原生短索引。归属未知的 Claude 来源额外需要 `confirmProject: true`，Codex 全局库需要 `includeGlobal: true`。例如当前 `codex` 可以选择 Claude 来源；`claude-sdk` 会归一为 `claude`，同运行时的来源被排除，避免重复原生读取。`opencode` 等其他 Agent 可显式选择两种来源，模型名不参与目录推断。
3. `memory_search` 按关键词子串检索所选来源，再以返回的 ID 调用 `memory_read` 读取最新原文。工具不接受任意文件路径。
4. 用户说关闭时，`memory_select` 使用相同 Agent、项目和空 `ids` 清空选择。选择仅存在该 MCP 进程内，新会话、进程重启均需重新选择，不从目录缓存恢复。

`select` 返回最多 20 项文件元数据，以及 Claude 的 `MEMORY.md` 或 Codex 优先的 `memory_summary.md`（没有则 `MEMORY.md`）预览。每来源最多 60 行，所有预览合计最多 4000 字符，标记 `truncated`；没有原生索引时提示按需搜索，不用 LLM 生成替代索引。

搜索默认最多 10 条，可指定 `limit` 为 1–20；`query` 为 1–200 字。它逐个读取原文做子串匹配，拿到足够结果即停止，不提供语义排序、向量索引或自动摘要。检索片段、原文与索引均附带运行时、项目映射、路径和角色（index/summary/detail/evidence），明确标为外来历史，不能当作当前 Agent 的亲身经历、指令或授权。

## 扫描与边界

- 列出来源时自动发现，选择时重新检查候选；检索与读取时只检查已选来源的元数据，直接读取最新原文。新的来源目录在下一次列出来源时出现；所选文件的新增、修改、删除在下一次调用生效。没有安装或设置保存时的扫描 hook，不声称后台实时更新。
- 元数据保存到 `CODA_PLUGIN_STATE/<来源摘要>.json`，只含来源标签、文件 ID、路径、大小和修改时间；相同时不重写，有变化才原子替换。缓存可删除重建，正文和片段不会写入其中。状态只属于本机 Coda 实例，不经空间同步。当前 Coda 卸载保留插件状态目录；可在停止相关会话后删除本插件状态目录清理缓存。
- 不跟随符号链接，拒绝来源根被替换和目录越界。每来源至多 500 个 Markdown、目录至多 8 层；超出明确报错。原文每文件至多 256 KiB，搜索遇到过大或不可读文件会报告并继续其他文件。它不是操作系统级安全沙箱，来源目录须可信。
- 插件不会扫描凭据或会话记录，不会修改原生记忆机制。原生 Agent 如何在后续运行中总结已读资料仍由它自身决定，插件不能保证阻止原生后台再次总结这些内容。
- 宿主目前没有通用的新会话记忆复选框或动态系统指令插槽。本插件以 Skill 与工具完成显式选择、短索引加载，没有伪造客户端控件；Agent 是否遵循使用说明仍取决于该 Agent。

## 代码与验证

`discovery.mjs` 负责默认目录与环境变量来源发现，`sources.mjs` 负责原生目录适配和路径边界，`catalog.mjs` 负责元数据快照，`memory.mjs` 负责本会话选择和搜索读取，`server.mjs` 仅负责 MCP 接入。依赖锁定的 MCP SDK，要求 Node 24；没有定时器、watcher、数据库或后台服务。

```sh
npm ci --prefix plugins/memory
node --test test/plugins/memory/*.test.mjs
node bin/check.mjs plugins/memory --manifest
```

测试只操作临时构造的原生目录，不读取用户真实记忆。
