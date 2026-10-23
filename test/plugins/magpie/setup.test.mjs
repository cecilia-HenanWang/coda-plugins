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

test('a gateway that already answers where the model services point is left as it is', async t => {
  const home = machine(t), address = await gateway(t);
  const ran = await setup(home, address);
  assert.deepEqual([ran.code, ran.stdout.trim(), ran.stderr], [0, `Magpie 网关 http://${address}`, '']);
});

test('without a gateway, the machine\'s magpie is made a service, and setup waits for it to answer', async t => {
  const home = machine(t), log = join(home, 'magpie.log');
  const address = await gateway(t, () => existsSync(log) && readFileSync(log, 'utf8').includes('daemon install'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/magpie'), `#!/bin/sh\n[ "$1" = --version ] && { echo 'magpie 0.1.1320'; exit 0; }\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  const ran = await setup(home, address);
  assert.deepEqual([ran.code, ran.stdout.trim(), ran.stderr], [0, `Magpie 0.1.1320，网关 http://${address}`, '']);
  assert.equal(readFileSync(log, 'utf8'), 'daemon install\n');
});

test('the service is given the PATH Coda gives for programs that are not its own, which magpie reading Coda\'s folders at login can hang on', async t => {
  const home = machine(t), log = join(home, 'magpie.log');
  const address = await gateway(t, () => existsSync(log));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/magpie'), `#!/bin/sh\n[ "$1" = --version ] && { echo 'magpie 0.1.1320'; exit 0; }\necho "$PATH" >> '${log}'\n`, { mode: 0o755 });
  const ran = await setup(home, address, { CODA_USER_PATH: `${join(home, 'tools')}:/bin`, PATH: [join(home, 'state/credential-commands'), join(home, 'tools'), '/bin'].join(':') });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(readFileSync(log, 'utf8').trim(), `${join(home, 'tools')}:/bin`);
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
