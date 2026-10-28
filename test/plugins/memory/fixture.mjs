import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../../../plugins/memory/scripts/memory.mjs';

export function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coda-native-memory-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state'), project = join(root, 'project'), otherProject = join(root, 'other-project'), home = join(root, 'home');
  const claude = join(root, 'claude-memory'), codex = join(root, 'codex-memory');
  for (const path of [state, project, otherProject, home, claude, codex, join(codex, 'rollout_summaries'), join(codex, 'extensions'), join(codex, 'sessions')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(claude, 'MEMORY.md'), '# Claude 原生索引\n参见 topic.md\n');
  writeFileSync(join(claude, 'topic.md'), 'CLAUDE_BODY_UNIQUE：这个项目使用 pnpm。');
  writeFileSync(join(codex, 'memory_summary.md'), '# Codex 原生短索引\n');
  writeFileSync(join(codex, 'MEMORY.md'), '# Codex 详细索引\n');
  writeFileSync(join(codex, 'rollout_summaries', 'one.md'), 'CODEX_BODY_UNIQUE：历史运行时验证过 pnpm。');
  writeFileSync(join(codex, 'extensions', 'detail.md'), '扩展的原生记忆。');
  writeFileSync(join(codex, 'sessions', 'conversation.md'), '禁止扫描的会话记录。');
  writeFileSync(join(codex, 'raw_memories.md'), '禁止扫描的原始历史。');
  writeFileSync(join(claude, 'credentials.json'), '{"token":"NOT_READ"}');
  const settings = { 'memory.sources': {
    claude: { runtime: 'claude', project, path: claude }, codex: { runtime: 'codex', project, path: codex },
  } };
  return { root, state, project, otherProject, home, claude, codex, settings, memory: new Memory(settings, state, { home, env: {} }) };
}
