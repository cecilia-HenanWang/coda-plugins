import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_FILE_BYTES = 256 * 1024;
const identifier = value => createHash('sha256').update(value).digest('hex');
export const directory = path => {
  if (typeof path !== 'string' || !isAbsolute(path) || !lstatSync(path).isDirectory()) throw new Error('目录必须是存在的绝对路径，不能是符号链接');
  return realpathSync(path);
};

export function sources(settings) {
  const configured = settings['memory.sources'] ?? {};
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('memory.sources 必须是来源表格');
  return Object.entries(configured).map(([id, value]) => {
    if (!value || !['claude', 'codex'].includes(value.runtime)) throw new Error(`来源 ${id} 的 runtime 必须是 claude 或 codex`);
    if (value.project && (typeof value.project !== 'string' || !isAbsolute(value.project))) throw new Error(`来源 ${id} 的 project 必须是绝对路径或留空`);
    const project = value.project ? resolve(value.project) : null, path = directory(value.path);
    return { id, runtime: value.runtime, project, projectMapping: project ? 'user' : 'unconfirmed', scope: value.runtime === 'codex' ? 'global' : 'project', path };
  });
}

function allowed(runtime, path) {
  if (runtime === 'claude') return !path.includes('/') && /\.md$/i.test(path);
  return ['MEMORY.md', 'memory_summary.md'].includes(path) || /^(rollout_summaries|extensions)\/.+\.md$/i.test(path);
}

export function scan(source) {
  if (directory(source.path) !== source.path) throw new Error('来源目录已改变，请重新选择来源');
  const entries = [];
  const visit = (path, depth = 0) => {
    if (depth > 8) throw new Error(`来源 ${source.id} 的目录层级超过 8 层`);
    for (const item of readdirSync(join(source.path, path), { withFileTypes: true })) {
      const name = path ? `${path}/${item.name}` : item.name;
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
      if (item.isDirectory() && source.runtime === 'codex' && /^(rollout_summaries|extensions)(\/|$)/.test(name)) visit(name, depth + 1);
      else if (item.isFile() && allowed(source.runtime, name)) {
        const details = lstatSync(join(source.path, name));
        if (!details.isFile() || details.isSymbolicLink()) continue;
        entries.push({ id: identifier(`${source.runtime}\0${source.project}\0${source.path}\0${name}`), source: source.id,
          runtime: source.runtime, project: source.project, projectMapping: source.projectMapping, scope: source.scope,
          role: name === 'MEMORY.md' ? 'index' : name === 'memory_summary.md' ? 'summary' : name.startsWith('rollout_summaries/') ? 'evidence' : 'detail',
          path: join(source.path, name), bytes: details.size, modified: details.mtimeMs });
        if (entries.length > 500) throw new Error(`来源 ${source.id} 超过插件支持的 500 个记忆文件`);
      }
    }
  };
  visit('');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function read(source, entry) {
  const path = relative(source.path, entry.path);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) || !allowed(source.runtime, path.split(sep).join('/'))) throw new Error('记忆路径不属于所选来源');
  if (directory(source.path) !== source.path) throw new Error('来源目录已改变，请重新选择来源');
  let parent = source.path;
  for (const segment of path.split(sep)) {
    parent = join(parent, segment);
    if (lstatSync(parent).isSymbolicLink()) throw new Error('记忆路径不能包含符号链接');
  }
  const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.size > MAX_FILE_BYTES) throw new Error(`记忆文件须为不超过 ${MAX_FILE_BYTES} 字节的普通文件`);
    const text = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('记忆文件读取时超过大小限制');
    return text;
  } finally { closeSync(descriptor); }
}
