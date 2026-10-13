// The Kimi agent as Coda starts it (the plugin's `contributes.agents`): `kimi acp` as a child in this process's group, with a relay
// between it and Coda that speaks Coda's protocol for it (relay.mjs, docs/agent-protocol.md). It ends as Kimi ends.
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';
import { kimiBinary } from './binary.mjs';
import { KimiRelay } from './relay.mjs';

const startedAt = Date.now();
const kimi = spawn(kimiBinary() ?? 'kimi', ['acp'], { stdio: ['pipe', 'pipe', 'ignore'] });
kimi.stdin.on('error', () => {});
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const relay = new KimiRelay({ startedAt, say: message => process.stdout.write(`${JSON.stringify(message)}\n`),
  tell: message => kimi.stdin.write(`${JSON.stringify(message)}\n`) });
readLines(process.stdin).on('line', line => { const message = parse(line); if (message) relay.fromCoda(message); }).on('close', () => kimi.stdin.end());
readLines(kimi.stdout).on('line', line => { const message = parse(line); if (message) relay.fromAgent(message); });
// What Kimi said before it ended reaches Coda before this process ends.
let ended = false;
const end = code => { if (ended) return; ended = true; relay.close(); void relay.drained().then(() => process.stdout.write('', () => process.exit(code))); };
kimi.on('close', code => end(code ?? 1));
kimi.on('error', () => end(1));
