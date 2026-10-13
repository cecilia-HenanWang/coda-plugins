// The checker against this repository's plugins (they pass every level) and against plugins that get Coda's contract
// wrong on purpose (each fails on the rule it breaks, and nothing else does).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../check/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = path => join(root, path);
const LIAR = at('test/fixtures/liar.mjs'), ICON = at('templates/agent/icons/echo.pdf');
// Short enough for a test, long enough for the templates.
const limits = { turn: 10_000, settle: 6_000, cancel: 2_000, exit: 1_000 };
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const rules = (report, status) => report.items.filter(item => item.status === status).map(item => item.rule);
const failed = report => rules(report, 'fail');
function assertPasses(report, expected) {
  assert.deepEqual(report.failures, [], 'no failures');
  const passed = rules(report, 'pass');
  for (const rule of expected) assert.ok(passed.includes(rule), `${rule} passed: ${passed.join(', ')}`);
}
// A plugin in a directory of its own outside Git: `agent` is merged into a declared agent that runs the liar in `mode`.
function plugin({ mode = 'honest', agent = {}, manifest = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-check-test-'));
  temps.push(dir);
  copyFileSync(ICON, join(dir, 'icon.pdf'));
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), content); }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'liar', displayName: '说错话', version: '1.0.0', ...manifest,
    contributes: { agents: [{ id: 'liar', displayName: '说错话', icon: { light: 'icon.pdf', template: true },
      command: `exec "$CODA_NODE" "${LIAR}" ${mode}`, ...agent }], ...manifest.contributes } }));
  return dir;
}

describe('this repository', () => {
  test('templates/agent passes every level', async () => {
    const { report } = await checkPlugin(at('templates/agent'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'manifest.agents', 'source.files', 'handshake.initialize', 'handshake.new', 'handshake.exit',
      'live.turn', 'live.cancel', 'live.updates']);
    assert.ok(rules(report, 'skip').includes('live.load'), 'session/load is not asked of an agent that does not declare it');
  });
  test('templates/agent registers a wait and takes a turn of its own', async () => {
    const { report } = await checkPlugin(at('templates/agent'), { live: true, prompt: 'wait 演示', limits });
    assertPasses(report, ['live.turn', 'live.waits', 'live.cancel', 'live.cancel-autonomous']);
    assert.match(report.items.find(item => item.rule === 'live.waits').message, /登记 1 个（task ×1），自主轮次 1 次，都已结束/);
    assert.match(report.items.find(item => item.rule === 'live.autonomous').message, /两秒到了/);
  });
  test('templates/panel reads as a panel', async () => {
    const { report } = await checkPlugin(at('templates/panel'), { live: true, limits });
    assertPasses(report, ['manifest.name', 'manifest.panels', 'panel.read']);
    assert.match(report.items.find(item => item.rule === 'panel.read').message, /card ×1.*button ×1.*meter ×1/);
  });
  test('plugins/cursor passes the manifest level', async () => {
    const { report, plugin: cursor } = await checkPlugin(at('plugins/cursor'), { manifestOnly: true });
    assertPasses(report, ['manifest.name', 'manifest.agents', 'source.files']);
    assert.equal(cursor.agents[0].command, 'c="$HOME/.local/bin/cursor-agent"; [ -x "$c" ] || c=cursor-agent; exec "$c" acp');
  });
  test('the command line exits 0 on a pass and 1 on a failure', () => {
    const run = (...args) => spawnSync(process.execPath, [at('bin/check.mjs'), ...args], { encoding: 'utf8' });
    const good = run(at('templates/panel'));
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /结果：通过/);
    assert.match(good.stdout, /权威校验仍是 Coda 的「读取来源」/);
    const bad = run(plugin({ mode: 'no-model' }));
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, /✗ session\/new 没报当前模型/);
    assert.equal(run().status, 2);
  });
});

describe('a liar fails on the rule it breaks', () => {
  const cases = [
    ['protocol-version', 'handshake.protocol', {}],
    ['no-model', 'handshake.model', {}],
    ['bad-update', 'update.schema', { live: true }],
    ['foreign-session', 'update.session', { live: true }],
    ['bad-wait', 'wait.invalid', { live: true }],
    ['after-terminal', 'wait.after-terminal', { live: true }],
    ['subagent-no-child', 'wait.subagent-child', { live: true }],
    ['timer-no-at', 'wait.timer-at', { live: true }],
    ['permission-outside', 'request.outside-turn', { live: true }],
    ['ignore-cancel', 'live.cancel', { live: true }],
    ['linger', 'handshake.exit', {}],
    ['load-fails', 'handshake.load', { live: true }],
  ];
  for (const [mode, rule, options] of cases) test(mode, async () => {
    const { report } = await checkPlugin(plugin({ mode }), { ...options, limits });
    assert.deepEqual([...new Set(failed(report))], [rule], JSON.stringify(report.failures, null, 1));
  });
  test('an honest one passes', async () => {
    const { report } = await checkPlugin(plugin(), { live: true, limits });
    assertPasses(report, ['live.turn', 'live.cancel']);
  });
  test('signed out is skipped, not failed', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'signed-out' }), { live: true, limits });
    assert.deepEqual(failed(report), []);
    assert.ok(rules(report, 'skip').includes('handshake.signed-out'));
  });
  test('approvals in a turn are refused', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'permission' }), { live: true, limits });
    assertPasses(report, ['live.turn']);
    assert.match(report.items.find(item => item.rule === 'live.turn').message, /审批答复 \{"outcome":\{"outcome":"selected","optionId":"no"\}\}/);
  });
  test('waits said while the session opens are kept for it', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'wait-while-loading' }), { limits });
    assert.deepEqual(failed(report), []);
  });
  test('noise on standard output is worth a look', async () => {
    const { report } = await checkPlugin(plugin({ mode: 'stdout-noise' }), { live: true, limits });
    assert.deepEqual(failed(report), []);
    assert.ok(rules(report, 'warn').includes('wire.noise'));
  });
  test('a command that does not start', async () => {
    const { report } = await checkPlugin(plugin({ agent: { command: 'exec definitely-not-installed-agent acp' } }), { limits });
    assert.deepEqual(failed(report), ['handshake.initialize']);
    assert.match(report.failures[0].message, /进程退出了（退出码 127）/);
  });
});

describe('manifests Coda does not take', () => {
  const manifestFails = async (options, rule, message) => {
    const { report } = await checkPlugin(plugin(options), { manifestOnly: true });
    assert.ok(failed(report).includes(rule), JSON.stringify(report.items, null, 1));
    if (message) assert.match(report.failures.find(f => f.rule === rule).message, message);
  };
  test('an icon over 32 KiB', () => manifestFails({ agent: { icon: { light: 'big.pdf' } },
    files: { 'big.pdf': `%PDF-1.7\n${'%'.repeat(33 * 1024)}` } }, 'manifest.agents', /超过 32 KiB/));
  test('an icon that is not a PDF', () => manifestFails({ agent: { icon: { light: 'icon.svg' } }, files: { 'icon.svg': '<svg/>' } }, 'manifest.agents', /须为 PDF/));
  test('a command over two lines', () => manifestFails({ agent: { command: 'exec a\nexec b' } }, 'manifest.agents', /一行/));
  test('a key Coda does not read', () => manifestFails({ agent: { args: ['acp'] } }, 'manifest.agents', /不支持的键：args/));
  test('a built-in plugin name', () => manifestFails({ manifest: { name: 'grok' } }, 'manifest.name', /内置插件同名/));
  test('a built-in agent ID', () => manifestFails({ agent: { id: 'claude-sdk' } }, 'manifest.agent-id', /内置插件 claude/));
  test('npm dependencies', () => manifestFails({ manifest: { dependencies: { left: '1.0.0' } } }, 'source.npm'));
  test('a symbolic link', async () => {
    const dir = plugin();
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    const { report } = await checkPlugin(dir, { manifestOnly: true });
    assert.deepEqual(failed(report), ['source.symlink']);
  });
  test('a contribution Coda does not know', () => manifestFails({ manifest: { contributes: { commands: [] } } }, 'manifest.contributes'));
  test('a panel whose output Coda cannot read', async () => {
    const dir = plugin({ files: { 'panel.mjs': `console.log(JSON.stringify({ items: [{ type: 'meter', label: '用量', fraction: 1.5 }] }))` },
      manifest: { contributes: { panels: [{ id: 'usage', title: '用量', command: 'node "$CODA_PLUGIN_PATH/panel.mjs"' }] } } });
    const { report } = await checkPlugin(dir, { agent: null, limits });
    assert.ok(failed(report).includes('panel.output'), JSON.stringify(report.items, null, 1));
    assert.match(report.failures.find(f => f.rule === 'panel.output').message, /fraction 须在 0–1 之间/);
  });
});
