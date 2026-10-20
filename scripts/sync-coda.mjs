#!/usr/bin/env node
// 合并后把内置插件的副本同步进 Coda（.coda/workflows/sync-coda.bpmn）。Coda 带的是这里某个提交的只读副本，换副本由 Coda 的
// scripts/sync-plugins.mjs 做（Coda 的 docs/development.md「coda-plugins 维护的内置插件」）：这里在 Coda 的一份克隆上用它取这个提交，
// 推到固定的分支 sync/coda-plugins，再给它开 PR；PR 已开着就更新分支与它的标题、正文。开 PR 的 gh 是 Coda 的：步骤带着负责这次运行的会话，
// PR 登记在它上面，由 Coda 那边的 PR 流程跟进。Coda 或开着的同步 PR 已包含这个提交时什么都不推；副本与 Coda 的相同时也不推，
// 开着的同步 PR 就此关掉，免得它分支上已被撤回的改动合进去。
//
//   node scripts/sync-coda.mjs     在流程步骤里：GITHUB_SHA 是要同步的提交，GITHUB_WORKSPACE 是它的检出
// 提交署谁的名、推送用哪个账号，由 Coda 按 Coda 仓库的地址决定。
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRANCH = 'sync/coda-plugins', LOCK = 'backend/src/resources/plugins.lock.json', CHECKER = ['package.json', 'bin', 'check'];
const CODA = 'https://github.com/coda-console/coda.git', SLUG = 'coda-console/coda';
const here = process.env.GITHUB_WORKSPACE || process.cwd(), sha = process.env.GITHUB_SHA;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const tried = (command, args, cwd) => { try { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; } };
const short = commit => commit.slice(0, 7);
const output = (name, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF_${name}\n${value}\nEOF_${name}\n`); };
const done = (line, pr = '') => {
  console.log(line); output('line', line); output('pr', pr);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  process.exit(0);
};
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) { console.error('没有要同步的提交（GITHUB_SHA）'); process.exit(2); }

const coda = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'sync-coda-')), 'coda');
run('git', ['clone', '--quiet', '--no-tags', CODA, coda]);
// The commit a copy of Coda's is taken from, and whether that copy has this commit already.
const lockAt = ref => { const text = tried('git', ['show', `${ref}:${LOCK}`], coda); return text ? JSON.parse(text) : null; };
const covers = commit => commit === sha || tried('git', ['merge-base', '--is-ancestor', sha, commit], here) !== null;

const main = lockAt('origin/main');
if (!main) { console.error(`Coda 的 main 上读不到 ${LOCK}`); process.exit(1); }
if (covers(main.commit)) done(`Coda 的副本取自 ${short(main.commit)}，已包含 ${short(sha)}`);
const open = run('gh', ['pr', 'list', '-R', SLUG, '--head', BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url'], coda);
const pending = open && tried('git', ['fetch', '--quiet', 'origin', BRANCH], coda) !== null ? lockAt('FETCH_HEAD') : null;
if (pending && covers(pending.commit)) done(`同步 PR 已取自 ${short(pending.commit)}，包含 ${short(sha)}：${open}`, open);

run('git', ['switch', '--quiet', '-C', BRANCH, 'origin/main'], coda);
run('node', ['scripts/sync-plugins.mjs', 'update', sha, '--from', here], coda);
const changed = run('git', ['status', '--porcelain', '--', '.', `:!${LOCK}`], coda);
if (!changed && open) {
  run('gh', ['pr', 'close', open, '--delete-branch', '--comment', `内置插件在 ${short(sha)} 与 Coda 的副本相同，这个同步 PR 不再需要。`], coda);
  done(`内置插件在 ${short(sha)} 与 Coda 的副本相同，已关闭同步 PR：${open}`);
}
if (!changed) done(`内置插件在 ${short(sha)} 与 Coda 的副本相同，不用同步`);
// The copies' overrides are written into Coda's backend/package.json by the update; their npm packages go into its lock here.
if (/package(-lock)?\.json$/m.test(changed))
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], join(coda, 'backend'));

// What changed in the copies since Coda's: this repository's commits that touch them, their PR numbers pointing here.
const paths = [...Object.values(main.plugins).map(p => p.path), ...CHECKER];
const log = (tried('git', ['log', '--format=%s', `${main.commit}..${sha}`, '--', ...paths], here) ?? '').split('\n').filter(Boolean)
  .map(subject => `- ${subject.replace(/\(#(\d+)\)/g, '(coda-console/coda-plugins#$1)')}`);
const title = `同步 coda-plugins 的内置插件副本到 ${short(sha)}`;
const body = [`取自 https://github.com/coda-console/coda-plugins/commit/${sha}，上次是 ${short(main.commit)}。`,
  log.length ? `这期间改到副本的提交：\n\n${log.join('\n')}` : '', '由 coda-plugins 的部署流程 sync-coda 生成；同步分支每次从 main 重建，不要在上面另加提交。'].filter(Boolean).join('\n\n');
run('git', ['add', '-A'], coda);
run('git', ['commit', '--quiet', '-m', `${title}\n\n${body}`], coda);
run('node', ['scripts/sync-plugins.mjs', 'check'], coda);
run('git', ['push', '--quiet', '--force', 'origin', BRANCH], coda);
if (open) {
  run('gh', ['pr', 'edit', open, '--title', title, '--body', body], coda);
  done(`同步 PR 已更新到 ${short(sha)}：${open}`, open);
}
const url = run('gh', ['pr', 'create', '-R', SLUG, '--base', 'main', '--head', BRANCH, '--title', title, '--body', body, '--ready'], coda).split('\n').at(-1);
done(`已开同步 PR：${url}`, url);
