// The Cursor agent as Coda starts it (the plugin's `contributes.agents`): `cursor-agent acp` as a child in this process's group,
// its ACP passed on a message at a time both ways, but for Coda's session instructions, which this entry declares and puts in
// front of a new session's first prompt (instructions.mjs). It ends as Cursor ends, once what it said has reached Coda.
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';
import { cursorBinary } from './binary.mjs';
import { SessionInstructions } from './instructions.mjs';

const cli = spawn(cursorBinary() ?? 'cursor-agent', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'] });
cli.stdin.on('error', () => {});
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const say = message => process.stdout.write(`${JSON.stringify(message)}\n`), instructions = new SessionInstructions();
readLines(process.stdin).on('line', line => {
  const message = parse(line);
  if (!message) return;
  const { agent, coda } = instructions.fromCoda(message);
  if (coda) say(coda); else cli.stdin.write(`${JSON.stringify(agent)}\n`);
}).on('close', () => cli.stdin.end());
readLines(cli.stdout).on('line', line => { const message = parse(line); if (message) say(instructions.fromAgent(message)); });
let ended = false;
const end = code => { if (ended) return; ended = true; process.stdout.write('', () => process.exit(code)); };
cli.on('close', code => end(code ?? 1));
cli.on('error', () => end(1));
