// The Magpie plugin's setup, run as Coda runs it from its manifest, with the gateway stood in by a server of the test's
// (MAGPIE_ADDR, which magpie itself takes too) and magpie by a script in the machine's ~/.local/bin. No curl is on the
// PATH, so an install would fail rather than reach the network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifest, pluginEnv, run } from '../command.mjs';
import { magpieBinary } from '../../../plugins/magpie/scripts/setup.mjs';

// A gateway that answers its model list once `ready()` says so, and refuses until then.
async function gateway(t, ready) {
  const server = createServer((req, res) => { res.statusCode = ready() ? 200 : 503; res.end('{"object":"list","data":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `127.0.0.1:${server.address().port}`;
}
function machine(t) {
  const home = mkdtempSync(join(tmpdir(), 'coda-magpie-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
const setup = (home, address) => run(manifest('magpie').contributes.setup.command,
  pluginEnv('magpie', { HOME: home, CODA_NODE: process.execPath, PATH: '/bin', MAGPIE_ADDR: address }), { timeoutMs: 40_000 });

test('a gateway that already answers is left as it is', async t => {
  const home = machine(t), address = await gateway(t, () => true);
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

test('magpie is found where its installer links it before the PATH', t => {
  const home = machine(t), bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'magpie'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(magpieBinary({ PATH: bin }, home), join(bin, 'magpie'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/magpie'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(magpieBinary({ PATH: bin }, home), join(home, '.local/bin/magpie'));
});
