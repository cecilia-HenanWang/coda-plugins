// The Magpie plugin's setup, run as Coda runs it from its manifest, from a copy of the plugin whose model services point at
// a gateway the test stands in, and magpie by a script in the machine's ~/.local/bin. No curl is on the PATH, so an install
// would fail rather than reach the network.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifest, pluginEnv, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { magpieBinary } from '../../../plugins/magpie/scripts/setup.mjs';

// A gateway that answers its model list once `ready()` says so, and refuses until then; or, given `page`, another app that
// answers every path with it.
async function gateway(t, ready = () => true, page = null) {
  const server = createServer((req, res) => { res.statusCode = page || ready() ? 200 : 503; res.end(page ?? '{"object":"list","data":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `127.0.0.1:${server.address().port}`;
}
function machine(t) {
  const home = mkdtempSync(join(tmpdir(), 'coda-magpie-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
// The plugin, its model services moved to `address`, set up on the machine at `home`.
function setup(home, address, env = {}) {
  const copy = join(home, 'plugin');
  cpSync(pluginDir('magpie'), copy, { recursive: true });
  const declared = manifest('magpie');
  for (const provider of declared.contributes.modelProviders) provider.url = provider.url.replace('127.0.0.1:3425', address);
  writeFileSync(join(copy, 'package.json'), JSON.stringify(declared));
  return run(declared.contributes.setup.command, { ...pluginEnv('magpie', { HOME: home, CODA_NODE: process.execPath, PATH: '/bin', ...env }),
    CODA_PLUGIN_PATH: copy }, { timeoutMs: 40_000 });
}

// The machine's magpie, in ~/.local/bin: it says its version, and writes down in `log` what else it is asked (`record`,
// shell that has LOG for the file: by default its arguments) and, asked its version, whether the sign-ins were to stay unread.
function magpie(home, log, record = 'echo "$@" >> "$LOG"') {
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/magpie'), `#!/bin/sh\nLOG='${log}'\n` +
    `[ "$1" = --version ] && { [ "$LOG_VERSION" = 1 ] && echo "--version \${MAGPIE_NO_ACCOUNTS:-}" >> "$LOG"; echo 'magpie 0.1.1320'; exit 0; }\n${record}\nexit 0\n`, { mode: 0o755 });
}
const said = log => existsSync(log) ? readFileSync(log, 'utf8') : '';

test('a gateway that already answers where the model services point is left as it is, told whether to read the agents\' sign-ins', async t => {
  const home = machine(t), log = join(home, 'magpie.log'), address = await gateway(t);
  magpie(home, log);
  const ran = await setup(home, address);
  assert.deepEqual([ran.code, ran.stdout.trim(), ran.stderr], [0, `Magpie 网关 http://${address}`, '']);
  assert.equal(said(log), 'accounts discovery on\n', 'on, as Magpie has it unless the setting says off');
  assert.equal((await setup(home, address, { CODA_PLUGIN_SETTINGS: '{"magpie.accountDiscovery":false}' })).code, 0);
  assert.equal(said(log), 'accounts discovery on\naccounts discovery off\n');
});

// Magpie's app, where magpie is looked for last, is no test's to stand in for.
test('a gateway answering with no magpie command here to tell is refused', { skip: existsSync('/Applications/magpie.app') && 'magpie.app is on this machine' }, async t => {
  const home = machine(t), address = await gateway(t);
  const ran = await setup(home, address);
  assert.equal(ran.code, 1);
  assert.equal(ran.stderr.trim(), `http://${address} 上的 Magpie 网关在应答，但这台机器上找不到 magpie 命令，没法设置是否读取 Agent 自己的登录`);
});

test('without a gateway, the machine\'s magpie is told the setting and made a service, and setup waits for it to answer', async t => {
  const home = machine(t), log = join(home, 'magpie.log');
  const address = await gateway(t, () => said(log).includes('daemon install'));
  magpie(home, log);
  const ran = await setup(home, address, { CODA_PLUGIN_SETTINGS: '{"magpie.accountDiscovery":false}', LOG_VERSION: '1' });
  assert.deepEqual([ran.code, ran.stdout.trim(), ran.stderr], [0, `Magpie 0.1.1320，网关 http://${address}`, '']);
  // Asked its version before that, magpie moving its files as it starts reads no sign-in either.
  assert.equal(said(log), '--version 1\naccounts discovery off\ndaemon install\n--version \n', 'before its gateway first reads a sign-in');
});

test('the service is given the PATH Coda gives for programs that are not its own, which magpie reading Coda\'s folders at login can hang on', async t => {
  const home = machine(t), log = join(home, 'magpie.log');
  const address = await gateway(t, () => existsSync(log));
  magpie(home, log, '[ "$1" != daemon ] || echo "$PATH" >> "$LOG"');
  const ran = await setup(home, address, { CODA_USER_PATH: `${join(home, 'tools')}:/bin`, PATH: [join(home, 'state/credential-commands'), join(home, 'tools'), '/bin'].join(':') });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(said(log).trim(), `${join(home, 'tools')}:/bin`);
});

test('a MAGPIE_ADDR elsewhere is refused, even with a gateway answering there', async t => {
  const home = machine(t), elsewhere = await gateway(t), address = await gateway(t, () => false);
  const ran = await setup(home, address, { MAGPIE_ADDR: elsewhere });
  assert.equal(ran.code, 1);
  assert.equal(ran.stderr.trim(), `MAGPIE_ADDR=${elsewhere} 让 Magpie 网关不在 ${address}，而插件的模型服务指向那里：去掉它再安装`);
});

test('another app answering on the gateway\'s port is not taken for the gateway', async t => {
  const home = machine(t), address = await gateway(t, undefined, '<!doctype html><title>app</title>');
  const ran = await setup(home, address);
  assert.equal(ran.code, 1);
  assert.equal(ran.stderr.trim(), `${address} 上的服务不是 Magpie 网关（它的 /v1/models 不是模型列表）：先停掉它再安装`);
});

test('the model services share one gateway, the one setup makes sure of', () => {
  assert.deepEqual([...new Set(manifest('magpie').contributes.modelProviders.map(p => new URL(p.url).host))], ['127.0.0.1:3425']);
});

test('magpie is found where its installer links it before the PATH', t => {
  const home = machine(t), bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'magpie'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(magpieBinary({ PATH: bin }, home), join(bin, 'magpie'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/magpie'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(magpieBinary({ PATH: bin }, home), join(home, '.local/bin/magpie'));
});
