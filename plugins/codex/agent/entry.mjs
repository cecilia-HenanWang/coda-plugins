// The Codex agent as Coda starts it (the plugin's `contributes.agents`): the locked codex-acp, run in this process with Coda's
// patches, which fail the start once the adapter changes. Between it and Coda the entry speaks Coda's protocol for it
// (waits.mjs, docs/agent-protocol.md). What Coda wants of Codex beyond ACP is set here: the mode a session starts in, and
// which Codex program runs, through the account bridge when another plugin chooses the account (accounts.mjs).
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountSource } from './account-source.mjs';
import { readLines } from './lines.mjs';
import { orderedCodexTitles } from './titles.mjs';
import { continuedCodexSubagents } from './subagents.mjs';
import { followCodexProcessExit } from './process-exit.mjs';
import { networkedCodexDevelopment } from './network.mjs';
import { codexOptionsAsShown } from './options.mjs';
import { input, listen, relayedCodexStreams } from './relay.mjs';
import { CodexWaits } from './waits.mjs';

const env = process.env;
// A session starts read-only, unless its machine's configuration says otherwise.
env.INITIAL_AGENT_MODE ??= 'read-only';
// Another plugin plugged into Codex's `account-source` point chooses the account (accounts.mjs): codex-acp then runs the
// account bridge as its Codex, through a small program written into this plugin's state, named for what it runs. A Codex
// program of the connection's own (`CODEX_PATH`) keeps its own login.
if (!env.CODEX_PATH && accountSource(env) && env.CODA_PLUGIN_STATE) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const program = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./accounts.mjs', import.meta.url)))} "$@"\n`;
  const shim = join(env.CODA_PLUGIN_STATE, `account-bridge-${createHash('sha256').update(program).digest('hex').slice(0, 12)}`);
  if (!existsSync(shim)) { writeFileSync(`${shim}.${process.pid}`, program, { mode: 0o700 }); renameSync(`${shim}.${process.pid}`, shim); }
  env.CODEX_PATH = shim;
}

const waits = new CodexWaits(), parse = line => { try { return JSON.parse(line); } catch { return null; } };
const say = message => process.stdout.write(`${JSON.stringify(message)}\n`);
listen(line => { for (const message of waits.fromAgent(parse(line))) say(message); });
readLines(process.stdin).on('line', line => {
  const message = parse(line);
  if (!message || typeof message !== 'object') return;
  const { agent, coda } = waits.fromCoda(message);
  for (const each of agent) input.write(`${JSON.stringify(each)}\n`);
  for (const each of coda) say(each);
}).on('close', () => input.end());

// codex-acp as Node finds it from here (its package names dist/index.js as its main): the plugin's own dependency.
const adapter = new URL(import.meta.resolve('@agentclientprotocol/codex-acp'));
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== adapter.href) return loaded;
  return { ...loaded, source: codexOptionsAsShown(relayedCodexStreams(orderedCodexTitles(followCodexProcessExit(continuedCodexSubagents(networkedCodexDevelopment(Buffer.from(loaded.source).toString('utf8'))))))) };
} });
await import(adapter.href);
