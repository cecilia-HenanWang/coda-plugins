// 改了的插件须升版本：只看 plugins/<id>/ 下的改动，新加的插件与只改测试的不比。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkVersions } from '../scripts/check-versions.mjs';

test('a changed plugin needs a higher version; tests, new plugins and untouched ones do not', t => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-versions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  const manifest = (id, version) => write(`plugins/${id}/package.json`, JSON.stringify({ name: id, version }));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid'); git('config', 'commit.gpgsign', 'false');
  manifest('codex', '1.4.0'); manifest('claude', '1.1.0'); write('plugins/codex/agent/entry.mjs', '1');
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'change');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'change'); };

  write('test/plugins/codex/entry.test.mjs', 'test'); manifest('cursor', '0.1.0'); commit();
  assert.deepEqual(checkVersions('main', root), []);

  write('plugins/codex/agent/entry.mjs', '2'); commit();
  assert.deepEqual(checkVersions('main', root), ['plugins/codex 改了，version 须高于 1.4.0（现在是 1.4.0）']);
  manifest('codex', '1.3.9'); commit();
  assert.match(checkVersions('main', root)[0], /须高于 1\.4\.0（现在是 1\.3\.9）/);
  manifest('codex', 'next'); commit();
  assert.deepEqual(checkVersions('main', root), ['plugins/codex：version「next」不是 x.y.z']);
  manifest('codex', '1.4.1'); commit();
  assert.deepEqual(checkVersions('main', root), []);
  // 依赖锁文件变了也算改了插件（如 Dependabot 升 CLI）。
  write('plugins/claude/package-lock.json', '{}'); commit();
  assert.deepEqual(checkVersions('main', root), ['plugins/claude 改了，version 须高于 1.1.0（现在是 1.1.0）']);
  manifest('claude', '1.2.0'); commit();
  assert.deepEqual(checkVersions('main', root), []);
});
