#!/usr/bin/env node
// 合并后把内置插件的新版本同步进 Coda（.coda/workflows/sync-coda.bpmn）。Coda 在 backend/package.json 里钉住它用的 @coda-console/<插件>
// 的版本（Coda 的 docs/development.md「coda-plugins 维护的内置插件」），所以分两步：
//
//   node scripts/sync-coda.mjs published   这个提交的包都在 npm 上了才过：还没有的，等这个提交的发布流程（publish.yml）跑完，
//                                          再等 registry 能读到；发布流程失败就带着它的地址失败。
//   node scripts/sync-coda.mjs sync        在 Coda 的一份克隆上把它用到的包升到这个提交的版本（只升不降），照抄插件的 overrides，
//                                          更新锁文件，推到固定的分支 sync/coda-plugins 并开 PR；PR 已开着就更新分支与它的标题、正文。
//
// 在流程步骤里：GITHUB_SHA 是要同步的提交，GITHUB_WORKSPACE 是它的检出。开 PR 的 gh 是 Coda 的：步骤带着负责这次运行的会话，
// PR 登记在它上面，由 Coda 那边的 PR 流程跟进。提交署谁的名、推送用哪个账号，由 Coda 按 Coda 仓库的地址决定。
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { newer } from './check-versions.mjs';
import { packages, published } from './publish-npm.mjs';

const BRANCH = 'sync/coda-plugins', MANIFEST = 'backend/package.json';
const CODA = 'https://github.com/coda-console/coda.git', SLUG = 'coda-console/coda', HERE_SLUG = 'coda-console/coda-plugins';
const SCOPE = '@coda-console/';

// ---- What changes in Coda ----
// The overrides a package asks for, with `$name` written out as the version of its own dependency of that name, as Coda's
// root package.json must have them (npm reads overrides from the root alone).
export function overridesOf(manifest) {
  const resolved = value => typeof value === 'string' ? (value.startsWith('$') ? manifest.dependencies?.[value.slice(1)] : value)
    : Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, resolved(inner)]));
  return resolved(manifest.overrides ?? {});
}
// Coda's packages of ours that this commit has a later version of: `{ name, field, from, to }`, from Coda's package.json
// (`coda`) and this commit's manifests (`available`, by name). One this commit has at the same or an earlier version stays.
export function bumps(coda, available) {
  return ['dependencies', 'devDependencies'].flatMap(field => Object.entries(coda[field] ?? {})
    .filter(([name, from]) => name.startsWith(SCOPE) && available.has(name) && newer(available.get(name).version, from))
    .map(([name, from]) => ({ name, field, from, to: available.get(name).version })));
}
// Coda's package.json with those versions, and the overrides they ask for in place of those their versions before asked
// for (`before`: their manifests at those versions, by name; one not known drops none). Coda's own overrides stay, and
// each in its place.
export function applied(coda, changes, available, before) {
  const next = structuredClone(coda);
  for (const { name, field, to } of changes) {
    next[field][name] = to;
    const asked = overridesOf(available.get(name));
    for (const key of Object.keys(overridesOf(before.get(name) ?? {}))) if (!Object.hasOwn(asked, key)) delete next.overrides?.[key];
    if (Object.keys(asked).length) next.overrides = Object.assign(next.overrides ?? {}, asked);
  }
  if (next.overrides && !Object.keys(next.overrides).length) delete next.overrides;
  return next;
}

// ---- The steps ----
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
const fail = line => { console.error(line); process.exit(1); };
// Waits for `fn` to give something, asking every `every` ms for at most `limit` ms; null if it never does.
async function until(fn, limit, every = 15_000) {
  for (const end = Date.now() + limit; ; await delay(every)) {
    const value = await fn();
    if (value || Date.now() >= end) return value || null;
  }
}
const ours = () => new Map(packages(here).map(({ dir, manifest }) => [manifest.name, { ...manifest, path: relative(here, dir) }]));

async function waitPublished() {
  const specs = [...ours().values()].map(({ name, version }) => `${name}@${version}`);
  let missing = specs.filter(spec => !published(spec));
  if (!missing.length) done(`${short(sha)} 的包都已在 npm 上`);
  console.log(`npm 上还没有 ${missing.join('、')}，等 ${short(sha)} 的发布流程`);
  // GitHub starts the run of a push a little after it; this commit may have none (dispatched on a later one).
  const runs = `repos/${HERE_SLUG}/actions/workflows/publish.yml/runs?head_sha=${sha}&per_page=1`;
  const latest = () => JSON.parse(run('gh', ['api', runs])).workflow_runs?.[0] ?? null;
  const started = await until(latest, 5 * 60_000);
  if (!started) fail(`npm 上还没有 ${missing.join('、')}，${short(sha)} 也没有发布流程的运行`);
  const finished = await until(() => { const now = latest(); return now?.status === 'completed' ? now : null; }, 30 * 60_000);
  if (!finished) fail(`发布流程半小时还没跑完：${started.html_url}`);
  if (finished.conclusion !== 'success') fail(`发布流程没有成功（${finished.conclusion}）：${finished.html_url}`);
  // A version just published takes a few minutes to be read everywhere.
  const left = await until(() => (missing = missing.filter(spec => !published(spec))).length === 0, 10 * 60_000);
  if (!left) fail(`发布流程成功了，npm 上十分钟后仍读不到 ${missing.join('、')}：${finished.html_url}`);
  done(`${short(sha)} 的包都已在 npm 上（${finished.html_url}）`);
}

function sync() {
  const coda = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'sync-coda-')), 'coda');
  run('git', ['clone', '--quiet', '--no-tags', CODA, coda]);
  const manifestAt = ref => { const text = tried('git', ['show', `${ref}:${MANIFEST}`], coda); return text ? JSON.parse(text) : null; };
  const main = manifestAt('origin/main');
  if (!main) fail(`Coda 的 main 上读不到 ${MANIFEST}`);
  const mine = ours(), changes = bumps(main, mine);
  if (!changes.length) done(`Coda 用的内置插件已是 ${short(sha)} 的版本或更新的`);

  const open = run('gh', ['pr', 'list', '-R', SLUG, '--head', BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url'], coda);
  // An open pull request's branch may be from a later commit than this one: nothing is pushed over it.
  if (open) run('git', ['fetch', '--quiet', 'origin', BRANCH], coda);
  const pending = open ? manifestAt('FETCH_HEAD') : null;
  if (open && !pending) fail(`同步 PR ${open} 的分支 ${BRANCH} 上读不到 ${MANIFEST}，不覆盖它`);
  if (pending && !bumps(pending, mine).length) done(`同步 PR 已是 ${short(sha)} 的版本或更新的：${open}`, open);

  // What each version before was published from says what it asked for, and what changed since.
  const before = new Map(), notes = [];
  for (const { name, from, to } of changes) {
    const head = tried('npm', ['view', `${name}@${from}`, 'gitHead', '--registry=https://registry.npmjs.org']);
    const path = mine.get(name).path, file = path ? `${path}/package.json` : 'package.json';
    const old = head && tried('git', ['show', `${head}:${file}`], here);
    if (old) before.set(name, JSON.parse(old));
    // The check package is the root's bin/ and check/; a plugin, its directory.
    const files = path ? [path] : ['bin', 'check', 'package.json'];
    const log = head ? (tried('git', ['log', '--format=%s', `${head}..${sha}`, '--', ...files], here) ?? '') : '';
    const lines = log.split('\n').filter(Boolean).map(subject => `  - ${subject.replace(/\(#(\d+)\)/g, `(${HERE_SLUG}#$1)`)}`);
    notes.push(`- \`${name}\` ${from} → ${to}`, ...lines);
  }
  const title = `升级 coda-plugins 的内置插件到 ${short(sha)}`;
  const body = [`取自 https://github.com/${HERE_SLUG}/commit/${sha} 发布到 npm 的版本：\n\n${notes.join('\n')}`,
    '由 coda-plugins 的部署流程 sync-coda 生成；同步分支每次从 main 重建，不要在上面另加提交。'].join('\n\n');

  run('git', ['switch', '--quiet', '-C', BRANCH, 'origin/main'], coda);
  writeFileSync(join(coda, MANIFEST), `${JSON.stringify(applied(main, changes, mine, before), null, 2)}\n`);
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], join(coda, 'backend'));
  run('git', ['add', '-A'], coda);
  run('git', ['commit', '--quiet', '-m', `${title}\n\n${body}`], coda);
  run('git', ['push', '--quiet', '--force', 'origin', BRANCH], coda);
  if (open) {
    run('gh', ['pr', 'edit', open, '--title', title, '--body', body], coda);
    done(`同步 PR 已更新到 ${short(sha)}：${open}`, open);
  }
  const url = run('gh', ['pr', 'create', '-R', SLUG, '--base', 'main', '--head', BRANCH, '--title', title, '--body', body], coda).split('\n').at(-1);
  done(`已开同步 PR：${url}`, url);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) { console.error('没有要同步的提交（GITHUB_SHA）'); process.exit(2); }
  if (step === 'published') await waitPublished();
  else if (step === 'sync') sync();
  else { console.error('用法：node scripts/sync-coda.mjs published|sync'); process.exit(2); }
}
