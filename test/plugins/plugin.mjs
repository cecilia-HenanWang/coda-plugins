// A plugin of this repository as its tests reach it: its directory, and the packages it depends on as it finds them, from
// its own node_modules (`npm ci` in its directory, or `node scripts/install-plugins.mjs`), never from a directory above it.
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginDir = id => fileURLToPath(new URL(`../../plugins/${id}`, import.meta.url));

// The file `specifier` resolves to from the plugin's directory; throws unless it is in the plugin's own node_modules.
export function resolveFrom(id, specifier) {
  const dir = pluginDir(id);
  let path = null;
  try { path = createRequire(join(dir, 'package.json')).resolve(specifier); } catch {}
  if (!path || relative(join(dir, 'node_modules'), path).split(sep)[0] === '..')
    throw new Error(`plugins/${id} 的依赖没装（${specifier}${path ? ` 解析到了插件目录之外：${path}` : ''}）：在 plugins/${id} 里 npm ci，或 node scripts/install-plugins.mjs`);
  return path;
}
