// codex-acp speaks ACP over these streams instead of standard input and output (`relayedCodexStreams`), so that the entry
// stands between it and Coda without another process: what Coda says reaches it through `input`; what it says leaves
// through `output`, a line at a time, to whoever `listen`s, in the order said.
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const input = new PassThrough();
let heard = () => {}, pending = '';
const decoder = new StringDecoder('utf8');
const take = text => {
  pending += text;
  for (let end; (end = pending.indexOf('\n')) >= 0;) { const line = pending.slice(0, end); pending = pending.slice(end + 1); heard(line); }
};
// Each line is passed on before the write is done: what codex-acp waits on having said has reached the listener.
export const output = new Writable({ write(chunk, _, done) { take(decoder.write(chunk)); done(); }, final(done) { take(decoder.end()); done(); } });
export const listen = listener => { heard = listener; };

const before = '  const acpJsonStream = createJsonStream(process.stdin, process.stdout);';
// Fails loudly once the locked adapter changes.
export function relayedCodexStreams(source) {
  if (source.split(before).length !== 2) throw new Error('codex-acp stream patch no longer matches the locked adapter');
  return `import * as codaRelay from ${JSON.stringify(import.meta.url)};\n${source.replace(before, '  const acpJsonStream = createJsonStream(codaRelay.input, codaRelay.output);')}`;
}
