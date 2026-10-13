// Stands a fixture in for a package a plugin finds by name (the Claude SDK, the Codex CLI), in a Node process of its own
// and every Node process it starts: `substituted({ specifier: path })` is the environment to give it. Imported through
// NODE_OPTIONS, it hooks how modules resolve, for `import`, `import.meta.resolve` and `require.resolve` alike. The fixture
// itself still finds the real package, which it may wrap.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const VARIABLE = 'CODA_TEST_SUBSTITUTES';
export const substituted = substitutes => ({
  NODE_OPTIONS: `--import=${JSON.stringify(import.meta.url)}`,
  [VARIABLE]: JSON.stringify(substitutes),
});

// The same in this process.
export function substitute(substitutes) {
  const urls = Object.fromEntries(Object.entries(substitutes).map(([name, path]) => [name, pathToFileURL(path).href]));
  registerHooks({
    resolve(specifier, context, next) {
      const url = Object.hasOwn(urls, specifier) ? urls[specifier] : null;
      return url && context.parentURL !== url ? { url, shortCircuit: true } : next(specifier, context);
    },
  });
}
if (process.env[VARIABLE]) substitute(JSON.parse(process.env[VARIABLE]));
