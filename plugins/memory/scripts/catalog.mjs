import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { directory, scan } from './sources.mjs';

export function refresh(state, source) {
  const entries = scan(source);
  const key = createHash('sha256').update(`${source.runtime}\0${source.project}\0${source.path}`).digest('hex');
  const target = join(directory(state), `${key}.json`), temporary = `${target}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify({ source, entries })}\n`;
  try { if (readFileSync(target, 'utf8') === text) return entries; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return entries;
}
