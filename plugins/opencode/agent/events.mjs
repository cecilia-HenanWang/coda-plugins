// OpenCode's events, as its own ACP reads them (its acp/event.ts): its server's /global/event, Server-Sent Events whose data
// is `{ directory, payload }`, a payload `{ type, properties }`. `opencode acp` serves on the address the entry gives it,
// behind the password it gives it (OPENCODE_SERVER_PASSWORD, user `opencode`; one too old for a password serves without).
// Followed from the start, the server being up a moment after OpenCode starts, before its ACP reads anything, and again
// whenever the stream ends, until stopped.
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { readLines } from './lines.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

// Calls `onEvent` with each payload. `connected` settles once the stream is first read; `stop` stops it.
export function followEvents(url, password, onEvent, pause = 100) {
  const stopped = new AbortController(), { signal } = stopped;
  let connect;
  const connected = new Promise(resolve => { connect = resolve; });
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const take = line => {
    if (!line.startsWith('data:')) return;
    const event = parse(line.slice(5));
    if (record(event?.payload)) try { onEvent(event.payload); } catch {}
  };
  (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${url}/global/event`, { headers: { authorization, accept: 'text/event-stream' }, signal });
        if (response.ok && response.body) {
          connect();
          const body = Readable.fromWeb(response.body).on('error', () => {});
          await new Promise(resolve => readLines(body).on('line', take).on('close', resolve));
        } else await response.body?.cancel().catch(() => {});
      } catch {}
      await delay(pause, undefined, { signal }).catch(() => {});
    }
  })();
  return { connected, stop: () => stopped.abort() };
}
