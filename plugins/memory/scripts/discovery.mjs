import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { directory, scan } from './sources.mjs';

export function discover({ home = homedir(), env = process.env } = {}) {
  const sources = [], errors = [];
  const nativeHome = (value, fallback) => value ? resolve(value.replace(/^~(?=$|\/)/, home)) : join(home, fallback);
  const attempt = (path, action) => {
    try { action(); }
    catch (error) { if (error.code !== 'ENOENT') errors.push({ path, error: error.message }); }
  };
  const add = (runtime, path, label) => {
    path = directory(path);
    const key = createHash('sha256').update(`${runtime}\0${path}`).digest('hex').slice(0, 16);
    const source = { id: `auto-${runtime}-${key}`, runtime, path, label, discovered: true, project: null,
      projectMapping: 'unconfirmed', scope: runtime === 'codex' ? 'global' : 'project' };
    sources.push({ ...source, files: scan(source).length });
  };
  const projects = join(nativeHome(env.CLAUDE_CONFIG_DIR, '.claude'), 'projects');
  attempt(projects, () => {
    const root = directory(projects);
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.')) continue;
      const memory = join(root, item.name, 'memory');
      attempt(memory, () => add('claude', memory, item.name));
    }
  });
  const codex = join(nativeHome(env.CODEX_HOME, '.codex'), 'memories');
  attempt(codex, () => add('codex', codex, 'Codex 原生全局记忆'));
  return { sources: sources.sort((left, right) => left.path.localeCompare(right.path)), errors };
}
