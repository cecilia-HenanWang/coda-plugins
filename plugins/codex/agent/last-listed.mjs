// The same file in the Claude, Codex and OpenCode plugins: an agent plugin imports nothing of another's.
// What a model service listed when it last answered, kept in the plugin's state directory (CODA_PLUGIN_STATE) under the
// service's name. One that cannot be asked now (its machine restarting, the network to it down) is listed as it last said
// rather than left out of the session's models, and of Coda's catalog of them for as long as that is kept; a request to it
// fails then as any request to it would. One never listed here, or without a state directory, keeps its asking's error.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const file = (state, ref) => join(state, 'service-models', `${ref.replaceAll('/', '.')}.json`);
const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const kept = path => { try { const models = JSON.parse(readText(path)); return Array.isArray(models) ? models : null; } catch { return null; } };

// `ask()`: the models the service lists now.
export async function lastListed(ref, ask, state, log) {
  let models;
  try { models = await ask(); } catch (error) {
    const last = state ? kept(file(state, ref)) : null;
    if (!last) throw error;
    log(`模型服务 ${ref} 列不出模型（${error.message}），沿用上次列出的 ${last.length} 个`);
    return last;
  }
  if (state) remember(file(state, ref), JSON.stringify(models));
  return models;
}

// Written when it is not that already, whole: another session's process may read it meanwhile.
function remember(path, text) {
  if (readText(path) === text) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text); renameSync(temporary, path);
  } catch { /* Not kept: what the service listed still stands. */ }
}
