// The OpenCode agent as Coda starts it (the plugin's `contributes.agents`): `opencode acp` as a child in this process's group,
// its ACP passed on a message at a time both ways, but for Coda's session instructions, which this entry declares and puts in
// front of a new session's first prompt (instructions.mjs), its models, which it groups by provider (groups.mjs), and a
// model service's long wait, which ends the turn instead (retries.mjs, read from OpenCode's events: events.mjs). It ends as
// OpenCode ends, once what it said has reached Coda.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readLines } from './lines.mjs';
import { opencodeBinary } from './binary.mjs';
import { SessionInstructions } from './instructions.mjs';
import { groupedModels } from './groups.mjs';
import { chosenServices, providerEnvironment, serviceNames } from './providers.mjs';
import { followEvents } from './events.mjs';
import { LongRetries } from './retries.mjs';

// A port of this machine nothing listens on, for OpenCode's server, which its ACP speaks to.
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const services = chosenServices(), names = serviceNames(services);
// OpenCode's server on an address and behind a password of this entry's, for its events; the user is OpenCode's own.
const port = await freePort(), password = randomBytes(24).toString('base64url');
const { OPENCODE_SERVER_USERNAME, ...env } = await providerEnvironment(process.env, fetch, services);
const cli = spawn(opencodeBinary() ?? 'opencode', ['acp', '--hostname', '127.0.0.1', '--port', String(port)],
  { env: { ...env, OPENCODE_SERVER_PASSWORD: password }, stdio: ['pipe', 'pipe', 'inherit'] });
cli.stdin.on('error', () => {});
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const say = message => process.stdout.write(`${JSON.stringify(message)}\n`), tell = message => cli.stdin.write(`${JSON.stringify(message)}\n`);
const instructions = new SessionInstructions();
const retries = new LongRetries(sessionId => tell({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
const events = followEvents(`http://127.0.0.1:${port}`, password, event => retries.event(event));
// What Coda says reaches OpenCode, in order, once its events are followed, so that a wait in the first prompt is heard too:
// its server is up before its ACP reads anything. An OpenCode whose events cannot be followed is told after FOLLOW_LIMIT.
const FOLLOW_LIMIT = 10_000;
let told = Promise.race([events.connected, delay(FOLLOW_LIMIT, undefined, { ref: false })]);
readLines(process.stdin).on('line', line => {
  const message = parse(line);
  if (!message) return;
  const { agent, coda } = instructions.fromCoda(message);
  if (coda) { say(coda); return; }
  told = told.then(() => { retries.toAgent(agent); tell(agent); });
}).on('close', () => { told = told.then(() => cli.stdin.end()); });
readLines(cli.stdout).on('line', line => { const message = parse(line); if (message) say(groupedModels(instructions.fromAgent(retries.fromAgent(message)), names)); });
let ended = false;
const end = code => { if (ended) return; ended = true; events.stop(); process.stdout.write('', () => process.exit(code)); };
cli.on('close', code => end(code ?? 1));
cli.on('error', () => end(1));
