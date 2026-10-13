// From Coda's backend/test/codex-accounts.test.mjs at 9ffb9911, as plain node:test. Its cases of the codex plugin's bridge
// alone are in codex/accounts.test.mjs; Coda moving its own earlier choice into this plugin's state stays in Coda.
// The codex-accounts plugin: the codex-account manager's accounts (scripts/manager.mjs), the「Codex 多账号」panel and its
// actions, and the source it plugs into Codex's `account-source` point, which a Codex session's account bridge runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { panelItems } from '../../../check/panel.mjs';
import { list, tokens } from '../../../plugins/codex-accounts/scripts/manager.mjs';
import { panel } from '../../../plugins/codex-accounts/scripts/quota.mjs';
import { declaredPanel, manifest, pluginEnv, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { substituted } from '../substitute.mjs';

async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coda-codex-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until(fn) { for (let i = 0; i < 1000; i++) { if (await fn()) return; await delay(10); } throw Error('timed out'); }
// The codex plugin's Codex CLI, as Coda hands this plugin the directory of the plugin it depends on, with `script` standing
// in for the CLI.
const codex = script => ({ ...substituted({ '@openai/codex/bin/codex.js': script }), CODA_PLUGIN_DEPENDENCIES: JSON.stringify({ codex: pluginDir('codex') }) });
const sourceCommand = manifest('codex-accounts').contributes.extensions['codex/account-source'].command;

// ---- The manager ----
const claims = (account, exp = Date.now() / 1000 + 1000) => `x.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'pro' } })).toString('base64url')}.x`;
const identity = account => createHash('sha256').update(account).digest('hex');
// A codex-account manager with these accounts, `active` the one in Codex's own home, which is this machine's own login.
async function manager(dir, accounts, active) {
  const at = { accounts: join(dir, 'manager'), native: join(dir, 'codex') };
  await mkdir(at.accounts, { recursive: true }); await mkdir(at.native, { recursive: true });
  await writeFile(join(at.accounts, 'account.lock'), '');
  await writeFile(join(at.accounts, 'registry.json'), JSON.stringify({ active, accounts: Object.fromEntries(accounts.map(a => [a, { account_id: `${a}-account`, plan_type: 'plus' }])) }));
  for (const a of accounts) {
    const home = a === active ? at.native : join(at.accounts, 'accounts', a);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: claims(`${a}-account`), refresh_token: 'NEVER-EXPORT' } }));
  }
  return at;
}

test('a manager account\'s tokens are read under its lock and bound to its identity, even when its alias is reused', async t => {
  const dir = await root(t), at = await manager(dir, ['alias', 'other'], 'alias');
  assert.equal(await list({ ...at, accounts: join(dir, 'none') }), null, 'no manager here');
  const accounts = await list(at);
  assert.deepEqual(accounts.map(a => [a.alias, a.identity, a.plan]), [['alias', identity('alias-account'), 'plus'], ['other', identity('other-account'), 'plus']]);
  const read = await tokens(identity('alias-account'), at);
  assert.equal(read.chatgptAccountId, 'alias-account'); assert.ok(!JSON.stringify(read).includes('NEVER-EXPORT'));
  assert.equal((await tokens(identity('other-account'), at)).chatgptAccountId, 'other-account', 'an idle one from its own directory');
  await assert.rejects(tokens('different-account', at), /已没有这个账号/);
  // The alias now names another account: what was chosen by identity is not handed over under it.
  await writeFile(join(at.accounts, 'registry.json'), JSON.stringify({ active: 'alias', accounts: { alias: { account_id: 'someone-else' } } }));
  await assert.rejects(tokens(identity('alias-account'), at), /已没有这个账号/);
  assert.equal((await tokens('native', at)).chatgptAccountId, 'alias-account', "this machine's own login, without the manager");
  await writeFile(join(at.native, 'auth.json'), JSON.stringify({ tokens: { access_token: claims('x', 0) } }));
  await assert.rejects(tokens('native', at), /本机登录的凭据读不到/);
});

test('reads wait for short holds of the manager\'s lock and say when it stays held', async t => {
  const dir = await root(t), at = await manager(dir, ['a'], 'a'), lockPath = join(at.accounts, 'account.lock');
  async function hold() {
    const child = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"rb"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()', lockPath]);
    const exited = once(child, 'exit'); t.after(() => child.kill());
    await once(child.stdout, 'data');
    return async () => { child.stdin.end(); await exited; };
  }
  const release = await hold(); let resolved = false;
  const reading = list(at).then(value => { resolved = true; return value; });
  await delay(180); assert.equal(resolved, false);
  await release(); assert.equal((await reading)[0].alias, 'a');
  const unlock = await hold();
  await assert.rejects(list(at), /账号管理器正在更新，请稍后重试/);
  await unlock();
});

// ---- The panel and its actions ----
const declared = declaredPanel('codex-accounts');
// What Coda takes of a reading: the item types, or a throw.
const takes = value => panelItems(JSON.stringify(value), declared);

test('the panel offers this machine\'s own login and each manager account, the one in use marked; one whose quota fails says so alone', async () => {
  const accounts = [{ alias: 'work', identity: 'w', plan: 'pro' }, { alias: 'home', identity: 'h', plan: 'plus' }];
  const early = Date.UTC(2026, 9, 20, 1) / 1000;
  const read = async account => {
    if (account.identity === 'h') throw Error('账号凭据不可用，请在账号管理器更新登录后重试');
    return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'c1', status: 'available', resetType: 'codexRateLimits', expiresAt: early, grantedAt: 0 }] } };
  };
  assert.deepEqual(await panel(null, null, read), { items: [] }, 'nothing without a manager');
  const { items } = await panel(accounts, 'w', read);
  assert.deepEqual(items, [
    { type: 'card', title: '本机登录', items: [{ type: 'button', label: '切换使用', action: 'select', args: { account: 'native' } },
      { type: 'markdown', text: '这台机器上 Codex 自己的登录，额度见「Codex」面板' }] },
    { type: 'card', title: 'work', subtitle: 'pro', items: [
      { type: 'button', label: '当前使用', action: 'select', args: { account: 'w' }, disabled: true },
      { type: 'button', label: '使用完全重置', action: 'reset', args: { account: 'w', creditId: 'c1' },
        confirm: '使用 work 的完全重置？\n用最早到期的那一次（2026/10/20 9:00 到期，UTC+8）。成功后消耗 1 次，无法撤销。' },
      { type: 'meter', label: '5 小时', value: '剩余 90%', fraction: 0.9 },
      { type: 'stat', label: '完全重置', value: '剩余 1 次' },
      { type: 'stat', label: '第 1 次', value: '2026/10/20 9:00 到期' }] },
    { type: 'card', title: 'home', subtitle: 'plus', items: [
      { type: 'button', label: '切换使用', action: 'select', args: { account: 'h' } },
      { type: 'error', text: '暂时无法获取额度：账号凭据不可用，请在账号管理器更新登录后重试' }] },
  ]);
  assert.deepEqual(takes({ items }), ['card', 'button', 'markdown', 'card', 'button', 'button', 'meter', 'stat', 'stat', 'card', 'button', 'error'], 'a reading Coda takes');
  // Nothing chosen is this machine's own login.
  assert.equal((await panel(accounts, null, read)).items[0].items[0].label, '当前使用');
  // However many accounts, a reading Coda takes; those left out are counted.
  const many = Array.from({ length: 60 }, (_, i) => ({ alias: `account-${i}`, identity: `i${i}`, plan: 'pro' }));
  const big = await panel(many, null, async () => ({ rateLimitResetCredits: { availableCount: 30, credits: Array.from({ length: 30 }, (_, i) =>
    ({ id: `c${i}`, status: 'available', resetType: 'codexRateLimits', expiresAt: early + i, grantedAt: 0 })) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < 64 * 1024);
  const cards = takes(big).filter(type => type === 'card').length - 1;
  assert.deepEqual(big.items.at(-1), { type: 'markdown', text: `另有 ${60 - cards} 个账号没有列出` });
});

// A Codex CLI standing in for the codex plugin's: its app-server takes any login handed to it and says it is that account,
// unless FAKE_REFUSE; it notes what it was asked.
async function cli(dir) {
  const script = join(dir, 'codex.mjs'), log = join(dir, 'asked.jsonl');
  await writeFile(script, `import { appendFileSync } from 'node:fs';
let buffer = '', signedIn = null;
process.stdin.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
  const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: m.method, account: m.params?.chatgptAccountId, home: process.env.CODEX_HOME, credit: m.params?.creditId }) + '\\n');
  if (m.id === undefined) continue;
  if (m.method === 'account/login/start') signedIn = m.params.chatgptAccountId;
  const result = m.method === 'account/read' ? { account: { type: 'chatgpt' }, workspaceRouting: { chatgptAccountId: process.env.FAKE_REFUSE ? 'someone-else' : signedIn } }
    : m.method === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } } }
    : m.method === 'account/rateLimitResetCredit/consume' ? { outcome: 'reset' } : m.method === 'turn/start' ? { turn: { id: 't1' } } : {};
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
} });`);
  return { script, asked: async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [] };
}

test('the panel, its switch and its reset sign each account in on its own, choose only what signed in, and the source says what was chosen', async t => {
  const dir = await root(t), at = await manager(dir, ['work', 'home'], 'work'), { script, asked } = await cli(dir), state = join(dir, 'state');
  await mkdir(state);
  const env = extra => pluginEnv('codex-accounts', { ...codex(script), CODA_PLUGIN_STATE: state, CODA_CODEX_ACCOUNTS: at.accounts, CODEX_HOME: at.native, ...extra });
  const exec = (command, extra = {}) => run(command, env(extra));
  const read = await exec(declared.command);
  assert.equal(read.code, 0, read.stderr);
  takes(JSON.parse(read.stdout));
  const { items } = JSON.parse(read.stdout);
  assert.deepEqual(items.map(c => [c.title, c.items[0].label]), [['本机登录', '当前使用'], ['work', '切换使用'], ['home', '切换使用']]);
  assert.equal(items[1].items.find(i => i.type === 'meter').value, '剩余 50%');
  const homes = new Set((await asked()).map(a => a.home));
  assert.ok(![...homes].includes(at.native), 'no account is read in Codex\'s own home');
  const choose = account => exec(declared.actions.select.command, { CODA_PANEL_ARGS: JSON.stringify({ account }) });
  assert.equal((await choose(identity('home-account'))).code, 0, 'a switch that signs in chooses');
  // One that does not chooses nothing.
  const failing = await exec(declared.actions.select.command, { CODA_PANEL_ARGS: JSON.stringify({ account: identity('home-account') }), FAKE_REFUSE: '1' });
  assert.equal(failing.code, 1); assert.match(failing.stderr, /^切换失败：Codex 登录后的账号与所选的不符/);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'selection.json'), 'utf8')), { account: identity('home-account') });
  const reset = await exec(declared.actions.reset.command, { CODA_PANEL_ARGS: JSON.stringify({ account: identity('work-account'), creditId: 'c1' }) });
  assert.equal(reset.code, 0, reset.stderr);
  assert.deepEqual((await asked()).filter(a => a.method === 'account/rateLimitResetCredit/consume').map(a => a.credit), ['c1']);

  // The source, as the bridge runs it: what is chosen, and its tokens.
  const source = spawn('/bin/sh', ['-c', sourceCommand], { env: env({}), stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => source.kill());
  const answers = [];
  source.stdout.on('data', chunk => answers.push(...chunk.toString().trim().split('\n').map(line => JSON.parse(line))));
  const ask = async message => { source.stdin.write(`${JSON.stringify(message)}\n`); await until(() => answers.some(a => a.id === message.id)); return answers.find(a => a.id === message.id); };
  assert.deepEqual(await ask({ id: 1, method: 'selected' }), { id: 1, result: { account: { id: identity('home-account'), name: 'home' } } });
  assert.equal((await ask({ id: 2, method: 'tokens', params: { account: identity('home-account') } })).result.chatgptAccountId, 'home-account');
  assert.equal((await choose('native')).code, 0);
  assert.deepEqual(await ask({ id: 3, method: 'selected' }), { id: 3, result: { account: { id: 'native', name: '本机登录' } } }, 'read anew each time');
  assert.equal((await ask({ id: 4, method: 'tokens', params: { account: 'nobody' } })).error.message, '账号管理器里已没有这个账号');
});

test('the codex plugin\'s account bridge, with this plugin\'s source plugged in, hands Codex the chosen account before a turn', async t => {
  const dir = await root(t), at = await manager(dir, ['work'], 'work'), { script, asked } = await cli(dir), state = join(dir, 'state');
  await mkdir(state);
  await writeFile(join(state, 'selection.json'), JSON.stringify({ account: identity('work-account') }));
  // What Coda hands the codex plugin's processes of the plugins plugged into its points (CODA_PLUGIN_EXTENSIONS).
  const extensions = { 'account-source': [{ plugin: 'codex-accounts', command: sourceCommand, path: pluginDir('codex-accounts'), state }] };
  const bridge = spawn(process.execPath, [join(pluginDir('codex'), 'agent/accounts.mjs'), 'app-server'], {
    env: { ...process.env, ...substituted({ '@openai/codex/bin/codex.js': script }), CODA_PLUGIN_EXTENSIONS: JSON.stringify(extensions), CODA_CODEX_ACCOUNTS: at.accounts, CODEX_HOME: at.native },
    stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => bridge.kill());
  const answers = [];
  bridge.stdout.on('data', chunk => answers.push(...chunk.toString().trim().split('\n').map(line => JSON.parse(line))));
  const ask = async message => { bridge.stdin.write(`${JSON.stringify(message)}\n`); await until(() => answers.some(a => a.id === message.id)); return answers.find(a => a.id === message.id); };
  await ask({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'codex-acp', version: '1' } } });
  assert.deepEqual((await ask({ id: 'turn', method: 'turn/start', params: { threadId: 'thread' } })).result, { turn: { id: 't1' } });
  const methods = (await asked()).map(a => a.method === 'account/login/start' ? `${a.method} ${a.account}` : a.method);
  assert.deepEqual(methods.slice(0, 5), ['initialize', 'initialized', 'account/login/start work-account', 'account/read', 'turn/start']);
});
