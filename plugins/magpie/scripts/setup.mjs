// The plugin's setup (`contributes.setup`), which Coda runs on each machine when the user installs or updates the plugin: it
// ends well once Magpie's gateway answers where this plugin's model services point. A Magpie app or service that already
// serves it is left as it is. Otherwise, without a magpie that runs, Magpie's own installer (https://usemagpie.ai/install.sh)
// puts magpie.app in /Applications (~/Applications when that is not writable) and links the command into ~/.local/bin, or
// on Linux the command alone there; then `magpie daemon install` runs the gateway as the user's own service (launchd on the
// Mac, systemd --user on Linux), started at login and again after a failure. Magpie updates itself, so one that runs is
// kept as it is. Why the machine is not ready is said in one line on standard error.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Where the gateway must answer: where this plugin's model services point (package.json, one host and port for them all),
// Magpie's own default 127.0.0.1:3425.
export const GATEWAY = new URL(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).contributes.modelProviders[0].url).host;

// What answers at `address`: `gateway` for an OpenAI model list (`{ object: 'list', data: [...] }`, as Magpie's gateway serves
// it), `other` for something else that answers the model list's path well (another app on the port), null for none.
export async function answering(address, fetcher = fetch) {
  let response;
  try { response = await fetcher(`http://${address}/v1/models`, { signal: AbortSignal.timeout(3000) }); } catch { return null; }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body?.object === 'list' && Array.isArray(body.data) ? 'gateway' : 'other';
}

const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
// The magpie command: the installer's link first (the backend's PATH need not have ~/.local/bin), then the PATH, then the app.
export function magpieBinary(env = process.env, home = homedir()) {
  return [join(home, '.local/bin/magpie'), ...String(env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'magpie')),
    '/Applications/magpie.app/Contents/MacOS/magpie', join(home, 'Applications/magpie.app/Contents/MacOS/magpie')].find(executable) ?? null;
}

// The version a magpie says it is (`magpie 0.1.1320`), null for one that does not run.
export function versionOf(binary) {
  const ran = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return ran.status === 0 ? /(\d+(?:\.\d+)+)/.exec(ran.stdout ?? '')?.[1] ?? `${ran.stdout ?? ''}`.trim().split('\n')[0] : null;
}

// The PATH the service keeps (magpie daemon install takes the one it is run with): the one Coda gives for programs that are
// not Coda's, without its own folders (CODA_USER_PATH). Magpie reads every PATH folder to find the agents' CLIs; started at
// login by launchd, it is not Coda, and opening a folder Coda keeps for itself can hold it there for good, and every
// request with it. A Coda that gives none, the PATH as it is.
export const servicePath = (env = process.env) => env.CODA_USER_PATH ?? env.PATH ?? '';

const fail = message => { console.error(message); process.exit(1); };

async function main() {
  const address = GATEWAY;
  // magpie, and the service it installs, take MAGPIE_ADDR: one elsewhere would serve where the model services do not point.
  if (process.env.MAGPIE_ADDR && process.env.MAGPIE_ADDR !== address)
    fail(`MAGPIE_ADDR=${process.env.MAGPIE_ADDR} 让 Magpie 网关不在 ${address}，而插件的模型服务指向那里：去掉它再安装`);
  const found = await answering(address);
  if (found === 'gateway') { console.log(`Magpie 网关 http://${address}`); return; }
  if (found === 'other') fail(`${address} 上的服务不是 Magpie 网关（它的 /v1/models 不是模型列表）：先停掉它再安装`);
  let binary = magpieBinary();
  if (!binary || !versionOf(binary)) {
    const reason = binary ? `Magpie 无法运行（${binary}）` : '这台机器上没有 Magpie';
    // What the installer prints goes to standard error with the rest of its story.
    const installed = spawnSync('bash', ['-c', 'set -o pipefail; curl -fsSL https://usemagpie.ai/install.sh | sh'], { stdio: ['ignore', 2, 2] });
    if (installed.status !== 0) fail(`${reason}，安装失败（退出码 ${installed.status ?? installed.signal}）`);
    binary = magpieBinary();
    if (!binary || !versionOf(binary)) fail(`${reason}，安装后仍找不到能运行的 magpie`);
  }
  const daemon = spawnSync(binary, ['daemon', 'install'], { stdio: ['ignore', 2, 2], timeout: 120_000, env: { ...process.env, PATH: servicePath() } });
  if (daemon.status !== 0) fail(`没能让 Magpie 网关常驻（magpie daemon install 退出码 ${daemon.status ?? daemon.signal}）`);
  for (let i = 0; i < 30 && await answering(address) !== 'gateway'; i++) await delay(1000);
  if (await answering(address) !== 'gateway') fail(`Magpie 网关没有在 http://${address} 应答，见 magpie daemon status`);
  console.log(`Magpie ${versionOf(binary)}，网关 http://${address}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
