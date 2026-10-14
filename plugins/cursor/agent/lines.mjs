// A copy of Coda's backend/src/adapters/json-lines.mjs: an agent plugin's entry imports nothing of Coda's (docs/plugins.md「Agent」).
// Reads newline-delimited JSON from a stream. Only \n ends a message: readline also
// ends lines at a lone \r and at U+2028/U+2029, which JSON leaves unescaped inside
// strings, so a tool output carrying them would split one message into pieces.
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// Emits 'line' for each message (a trailing \r is dropped) and 'close' once, when the
// input ends or closes or close() is called. Only a clean end delivers an unterminated
// last line; a destroyed input drops it. Input errors stay with the input's own handlers.
export function readLines(input) {
  const reader = new EventEmitter(), decoder = new StringDecoder('utf8');
  // The unfinished message stays in pieces until its \n arrives: appending each chunk to one
  // string and searching it would copy a large message over and over.
  let pending = [], closed = false;
  const emit = line => reader.emit('line', line.endsWith('\r') ? line.slice(0, -1) : line);
  const take = text => {
    let start = 0, end;
    while (!closed && (end = text.indexOf('\n', start)) >= 0) {
      pending.push(text.slice(start, end)); start = end + 1;
      const line = pending.join(''); pending = [];
      emit(line);
    }
    if (!closed && start < text.length) pending.push(text.slice(start));
  };
  const data = chunk => take(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const finish = () => {
    if (closed) return;
    take(decoder.end());
    if (pending.length && !closed) { const rest = pending.join(''); pending = []; emit(rest); }
    reader.close();
  };
  reader.close = () => {
    if (closed) return;
    closed = true;
    input.off('data', data); input.off('end', finish); input.off('close', reader.close);
    input.pause?.();
    reader.emit('close');
  };
  input.on('data', data); input.on('end', finish); input.on('close', reader.close);
  return reader;
}
