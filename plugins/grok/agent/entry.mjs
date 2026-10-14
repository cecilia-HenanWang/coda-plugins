// Coda's Grok entry: keep Grok's ACP traffic intact and supply standard approval modes through its native session flags.
import { grokBinary } from '../scripts/ask.mjs';
import { readLines } from './lines.mjs';
import { GrokRelay } from './relay.mjs';

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true; process.exitCode = code; relay.close();
  // The host signals the whole process group; also close the child when only our input closes or we receive a signal.
  setTimeout(() => process.exit(code), 1000).unref();
  process.stdin.destroy();
};
const relay = new GrokRelay({ binary: grokBinary() ?? 'grok', say: message => process.stdout.write(`${JSON.stringify(message)}\n`), ended: stop });
readLines(process.stdin).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message && typeof message === 'object' && !Array.isArray(message)) relay.fromCoda(message);
}).on('close', () => stop());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => stop());
