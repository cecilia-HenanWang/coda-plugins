// An agent's process as Coda's session host runs it (backend/src/adapters/session-host.mjs): `sh -c` in its own process
// group, one JSON-RPC message per line on standard input and output. Coda ignores standard error; the checker keeps its
// tail to say why a process ended. Request IDs are strings, as Coda's are once its host link names them.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const STDERR_TAIL = 4096;

export class AgentProcess {
  // `onMessage(message)`: every request and notification the agent sends, in order. `onNoise(line, why)`: a line Coda would drop.
  constructor({ command, cwd, env, onMessage = () => {}, onNoise = () => {} }) {
    this.generation = randomBytes(3).toString('hex'); this.next = 0; this.pending = new Map(); this.stderr = '';
    this.child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL); });
    this.exit = null;
    this.exited = new Promise(resolve => {
      this.child.on('error', error => { this.exit ??= { code: null, signal: null, error: error.message }; resolve(this.exit); });
      this.child.on('exit', (code, signal) => { this.exit ??= { code, signal }; resolve(this.exit); });
    });
    // What it wrote before it exited is read first: its output closes after it exits, or soon after when a child of it
    // holds the pipe.
    const drained = new Promise(resolve => this.child.on('close', resolve));
    this.exited.then(() => Promise.race([drained, new Promise(resolve => setTimeout(resolve, 200))])).then(() => {
      for (const { reject } of this.pending.values()) reject(new Exited(this.exit, this.lastWords()));
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { onNoise(line, 'not-json'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { onNoise(line, 'not-object'); return; }
      if ('id' in message && !('method' in message)) {
        const waiter = this.pending.get(message.id);
        if (waiter) { this.pending.delete(message.id); waiter.resolve(message); }
        return;
      }
      onMessage(message);
    });
  }
  get pid() { return this.child.pid; }
  write(message) { if (!this.exit && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  // The agent's whole answer, `{ result }` or `{ error }`; rejected with Timeout or Exited. `onReply` runs as the answer is
  // read, before the next line is: what the agent says after it comes after it.
  request(method, params, { timeout, id = `${this.generation}-${this.next++}`, onReply } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      this.pending.set(id, { resolve: m => { clearTimeout(timer); onReply?.(m); resolve(m); }, reject: e => { clearTimeout(timer); reject(e); } });
      if (timeout) timer = setTimeout(() => { this.pending.delete(id); reject(new Timeout(method, timeout)); }, timeout);
      if (this.exit) { this.pending.delete(id); clearTimeout(timer); reject(new Exited(this.exit, this.lastWords())); return; }
      this.write({ id, method, params });
    });
  }
  notify(method, params) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  respondError(id, code, message) { this.write({ id, error: { code, message } }); }
  // Closes its standard input; resolves to how long it took to exit, or null past `limit`.
  async closeInput(limit) {
    const started = Date.now();
    this.child.stdin.end();
    const done = await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, limit, null))]);
    return done ? Date.now() - started : null;
  }
  // Whatever is left of its process group goes, as Coda's host makes sure.
  kill() { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }
  lastWords() { return this.stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''; }
}

export class Timeout extends Error {
  constructor(method, ms) { super(`${method} ${ms / 1000} 秒没有答复`); this.ms = ms; }
}
export class Exited extends Error {
  constructor(exit, words) {
    super(`进程退出了（${exit.error ?? (exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code}`)}）${words ? `：${words}` : ''}`);
    this.exit = exit;
  }
}
