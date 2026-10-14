// A Grok process in this entry's process group. Normal traffic keeps its JSON-RPC IDs; only a replacement process's
// initialize/load/configure requests are private, before that process is exposed to the client.
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';

export class GrokPeer {
  constructor(binary, { message, ended }) {
    this.pending = new Map(); this.next = 0; this.stopped = false;
    this.child = spawn(binary, ['agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.stdin.on('error', () => {});
    readLines(this.child.stdout).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const waiting = !value.method && this.pending.get(value.id);
      if (waiting) { this.pending.delete(value.id); waiting(value); }
      else message(this, value);
    });
    const finish = code => {
      if (this.stopped) return;
      this.stopped = true; clearTimeout(this.killTimer);
      for (const answer of this.pending.values()) answer({ error: { code: -32603, message: 'Grok 进程已退出' } });
      this.pending.clear(); ended(this, code);
    };
    this.child.on('close', code => finish(code ?? 1));
    this.child.on('error', () => finish(1));
  }
  send(message) {
    if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params) {
    if (this.stopped) return Promise.reject({ code: -32603, message: 'Grok 进程已退出' });
    const id = `grok-mode-${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject({ code: -32603, message: `切换审批模式时 Grok 的 ${method} 没有答复` });
      }, 30_000);
      this.pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(reply.error) : resolve(reply.result); });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  close() {
    if (this.stopped || this.killTimer) return;
    this.child.stdin.end(); this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 800);
    this.killTimer.unref();
  }
}
