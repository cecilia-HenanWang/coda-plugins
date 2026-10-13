#!/usr/bin/env node
// Installs the npm dependencies of every plugin here that has a package-lock.json, as Coda installs a plugin's version
// directory: `npm ci` in the plugin's own directory, without dev dependencies or install scripts, optional (platform)
// packages included. The tests under test/plugins/ need them; the checker at the root does not.
//
//   node scripts/install-plugins.mjs [<插件 ID> …]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugins = fileURLToPath(new URL('../plugins', import.meta.url));
const wanted = process.argv.slice(2);
const ids = readdirSync(plugins).filter(id => existsSync(join(plugins, id, 'package-lock.json')) && (!wanted.length || wanted.includes(id)));
for (const id of wanted) if (!ids.includes(id)) { console.error(`plugins/${id} 没有 package-lock.json`); process.exit(2); }
for (const id of ids) {
  console.log(`plugins/${id}: npm ci`);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund'], { cwd: join(plugins, id), stdio: 'inherit' });
}
