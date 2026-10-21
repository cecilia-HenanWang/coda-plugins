import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applied, bumps, overridesOf } from '../scripts/sync-coda.mjs';

// Coda's backend/package.json, as sync-coda finds it on Coda's main.
const coda = () => ({
  name: 'coda-backend',
  overrides: { '@agentclientprotocol/codex-acp': { '@openai/codex': '0.162.1' }, 'bpmn-elements': '$bpmn-elements' },
  dependencies: { '@coda-console/claude': '1.3.1', '@coda-console/codex': '1.6.1', '@coda-console/review': '2.4.3', 'bpmn-elements': 'git+https://x#y' },
  devDependencies: { '@coda-console/plugin-check': '0.4.4' },
});
const codex = (version, codexCli, overrides = { '@agentclientprotocol/codex-acp': { '@openai/codex': '$@openai/codex' } }) =>
  ({ name: '@coda-console/codex', version, dependencies: { '@agentclientprotocol/codex-acp': '1.12.0', '@openai/codex': codexCli }, ...(overrides ? { overrides } : {}) });
const available = (...manifests) => new Map(manifests.map(m => [m.name, m]));

test('overrides are written out as the root needs them: $name is the version of its own dependency', () => {
  assert.deepEqual(overridesOf(codex('1.6.2', '0.163.0')), { '@agentclientprotocol/codex-acp': { '@openai/codex': '0.163.0' } });
  assert.deepEqual(overridesOf({ name: 'x' }), {});
});

test('only the packages of ours Coda uses are raised, and only to a later version', () => {
  const here = available(codex('1.6.2', '0.163.0'), { name: '@coda-console/claude', version: '1.3.1' }, { name: '@coda-console/review', version: '2.4.2' },
    { name: '@coda-console/cursor', version: '1.1.2' }, { name: '@coda-console/plugin-check', version: '0.4.5' });
  assert.deepEqual(bumps(coda(), here), [
    { name: '@coda-console/codex', field: 'dependencies', from: '1.6.1', to: '1.6.2' },
    { name: '@coda-console/plugin-check', field: 'devDependencies', from: '0.4.4', to: '0.4.5' }]);
  assert.deepEqual(bumps(coda(), available({ name: '@coda-console/claude', version: '1.3.1' })), [], 'the same version is no change');
});

test("Coda's package.json gets the versions and the overrides they ask for; its own overrides stay where they are", () => {
  const here = available(codex('1.6.2', '0.163.0'));
  const changes = bumps(coda(), here), next = applied(coda(), changes, here, available(codex('1.6.1', '0.162.1')));
  assert.equal(next.dependencies['@coda-console/codex'], '1.6.2');
  assert.deepEqual(next.overrides, { '@agentclientprotocol/codex-acp': { '@openai/codex': '0.163.0' }, 'bpmn-elements': '$bpmn-elements' });
  assert.deepEqual(Object.keys(next.overrides), ['@agentclientprotocol/codex-acp', 'bpmn-elements'], 'in the same order');
  // A version that no longer asks for one drops it; Coda's own is left alone.
  const dropped = available(codex('1.7.0', '0.164.0', null));
  assert.deepEqual(applied(coda(), bumps(coda(), dropped), dropped, available(codex('1.6.1', '0.162.1'))).overrides, { 'bpmn-elements': '$bpmn-elements' });
  // Without the manifest it was published with, what it asked for before is not known: nothing is written.
  assert.throws(() => applied(coda(), bumps(coda(), dropped), dropped, new Map()), /没有 @coda-console\/codex@1\.6\.1 的清单/);
  assert.equal(coda().dependencies['@coda-console/codex'], '1.6.1', 'what it was given is not changed');
});

// The sync step as the workflow runs it, against a Coda of this machine (Git is told to fetch Coda's address from it) and a
// gh and an npm that say what the test wants, writing down what they were asked.
const SCRIPT = fileURLToPath(new URL('../scripts/sync-coda.mjs', import.meta.url)), temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
function world({ branch } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sync-coda-test-')), git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, stdio: 'pipe' });
  temps.push(root);
  const write = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
  // This commit of this repository: the check package at Coda's version, codex at a later one.
  const here = join(root, 'here'), pub = { publishConfig: { access: 'public' } };
  write(join(here, 'package.json'), { name: '@coda-console/plugin-check', version: '0.4.4', ...pub });
  write(join(here, 'plugins/codex/package.json'), { ...codex('1.6.2', '0.163.0'), ...pub });
  // Coda: its main, and the sync branch a run pushed before.
  const bare = join(root, 'coda.git'), work = join(root, 'coda');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', work]);
  write(join(work, 'backend/package.json'), coda());
  git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'main');
  if (branch) {
    git(work, 'switch', '--quiet', '-c', 'sync/coda-plugins');
    write(join(work, 'backend/package.json'), { ...coda(), dependencies: { ...coda().dependencies, '@coda-console/codex': branch } });
    git(work, 'commit', '--quiet', '-am', '升级 coda-plugins 的内置插件到 aaaaaaa\n\n- `@coda-console/codex` 1.6.1 → 1.6.2');
  }
  git(work, 'push', '--quiet', bare, '--all');
  const bin = join(root, 'bin'), asked = join(root, 'asked');
  write(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "gh $*" >> "${asked}"\n[ "$1 $2" = "pr list" ] && [ -n "$OPEN" ] && echo "$OPEN"\nexit 0\n`);
  write(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "npm $*" >> "${asked}"\necho 'npm error code ETIMEDOUT' >&2\nexit 1\n`);
  for (const name of ['gh', 'npm']) chmodSync(join(bin, name), 0o755);
  const sync = (env = {}) => spawnSync(process.execPath, [SCRIPT, 'sync'], { encoding: 'utf8', env: { ...process.env, ...identity, ...env,
    PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKSPACE: here, RUNNER_TEMP: root, GITHUB_OUTPUT: '',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/coda-console/coda.git' } });
  return { sync, asked: () => existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : [],
    branch: () => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/sync/coda-plugins']).status === 0 };
}

test('without the manifest of the version Coda has, nothing is pushed: what it asked for is not known', () => {
  const { sync, asked, branch } = world(), result = sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /读不到 npm 上 @coda-console\/codex@1\.6\.1 的清单.*ETIMEDOUT/);
  assert.equal(branch(), false, 'no sync branch');
  assert.ok(!asked().some(line => /^gh pr (create|edit)/.test(line)), asked().join('\n'));
});

test('a sync branch already at these versions has its pull request told again what its commit says', () => {
  const { sync, asked } = world({ branch: '1.6.2' }), result = sync({ OPEN: 'https://github.com/coda-console/coda/pull/9' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /同步 PR 已是 aaaaaaa 的版本或更新的/);
  assert.deepEqual(asked().filter(line => line.startsWith('gh pr edit')),
    ['gh pr edit https://github.com/coda-console/coda/pull/9 --title 升级 coda-plugins 的内置插件到 aaaaaaa --body - `@coda-console/codex` 1.6.1 → 1.6.2']);
  assert.ok(!asked().some(line => line.startsWith('npm')), 'nothing is read of npm');
});
