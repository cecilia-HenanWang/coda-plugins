#!/usr/bin/env node
// 改了哪个插件就升哪个插件的版本：Coda 按清单的 version 认插件（遥测、插件页），版本不变就分不出改没改。
//   node scripts/check-versions.mjs <base>   与 <base> 的分叉点比较，CI 在 PR 上传 origin/<目标分支>
// 改动了 plugins/<id>/ 下任何文件（含 package-lock.json）的插件，version 须是合法的 x.y.z 且高于分叉点上的；
// 新加的插件不比。测试在 test/plugins/<id>/，只改测试不用升。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
export const newer = (a, b) => {
  const x = SEMVER.exec(a).slice(1, 4).map(Number), y = SEMVER.exec(b).slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

export function checkVersions(base, cwd = process.cwd()) {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}：${result.stderr.trim()}`);
    return result.stdout;
  };
  const fork = git('merge-base', base, 'HEAD').trim();
  const changed = new Set(git('diff', '--name-only', fork, 'HEAD', '--', 'plugins/').split('\n')
    .map(path => /^plugins\/([^/]+)\//.exec(path)?.[1]).filter(Boolean));
  const problems = [];
  for (const id of [...changed].sort()) {
    const read = ref => { try { return JSON.parse(git('show', `${ref}:plugins/${id}/package.json`)).version; } catch { return undefined; } };
    const before = read(fork), after = read('HEAD');
    if (after === undefined) continue; // 删掉的插件
    if (!SEMVER.test(after ?? '')) { problems.push(`plugins/${id}：version「${after}」不是 x.y.z`); continue; }
    if (before === undefined) continue; // 新加的插件
    if (!SEMVER.test(before) || !newer(after, before)) problems.push(`plugins/${id} 改了，version 须高于 ${before}（现在是 ${after}）`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) { console.error('用法：node scripts/check-versions.mjs <base>'); process.exit(2); }
  const problems = checkVersions(base);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log('改动的插件都升了版本');
}
