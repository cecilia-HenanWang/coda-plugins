// Answers from the Kimi CLI's own local server (`kimi web`), started for them alone and closed after. The CLI renews its
// login itself on the way; its tokens are never read here. Each path's JSON `data`, in order; one Kimi does not answer
// with `code: 0` is an error of its own. The server not starting, or not in time, fails them all.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class KimiUnavailable extends Error {}

export async function kimiWeb(paths, { binary, home, timeoutMs = 20000, closeTimeoutMs = 4000 }) {
  const cwd = await mkdtemp(join(tmpdir(), 'coda-kimi-web-'));
  const controller = new AbortController();
  let child, closed, timer;
  try {
    child = spawn(binary, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd, env: { ...process.env, ...(home ? { KIMI_CODE_HOME: home } : {}), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    closed = new Promise(resolve => child.once('close', resolve));
    let fail;
    const failed = new Promise((_, reject) => { fail = message => reject(new KimiUnavailable(message)); });
    child.once('error', () => fail('Kimi CLI 没能启动'));
    child.once('exit', () => fail('Kimi CLI 提前退出了'));
    timer = setTimeout(() => { controller.abort(); fail('Kimi CLI 没有答复'); }, timeoutMs);
    const ready = new Promise(resolve => {
      let buffer = '', size = 0;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 65536) return fail('Kimi CLI 的输出不对');
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end).replace(/\x1b\[[0-9;]*m/g, '');
          buffer = buffer.slice(end + 1);
          const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/?#token=([^\s]+)/);
          if (!match) continue;
          try {
            const url = new URL(match[0]), token = new URLSearchParams(url.hash.slice(1)).get('token');
            if (Number(url.port) > 0 && token) resolve({ origin: url.origin, token });
          } catch { fail('Kimi CLI 的输出不对'); }
        }
      });
    });
    return await Promise.race([failed, (async () => {
      const { origin, token } = await ready;
      const answers = [];
      for (const path of paths) {
        try {
          const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
          if (!response.ok) throw new Error(`Kimi 本地服务返回 ${response.status}`);
          const text = await response.text();
          if (text.length > 2 * 1024 * 1024) throw new Error('Kimi 的答复太大');
          const result = JSON.parse(text);
          if (result?.code !== 0) throw new Error('Kimi 没有给出结果');
          answers.push({ data: result.data });
        } catch (error) {
          if (controller.signal.aborted) throw new KimiUnavailable('Kimi CLI 没有答复');
          answers.push({ error: error.message });
        }
      }
      return answers;
    })()]);
  } finally {
    clearTimeout(timer); controller.abort();
    if (child) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), closeTimeoutMs);
      await closed;
      clearTimeout(killTimer);
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
