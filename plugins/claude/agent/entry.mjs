#!/usr/bin/env node
// The Claude agent as Coda starts it (the plugin's `contributes.agents`): Claude Code through the plugin's own Claude Agent SDK
// (its `@anthropic-ai/claude-agent-sdk` dependency), speaking ACP and Coda's waits over standard input and output
// (session.mjs). It ends when Coda's side of the pipe closes, when it is told to, or when its session ends.
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { ClaudeSession } from './session.mjs';

if (process.argv.includes('--help')) {
  process.stdout.write('coda-claude: Claude Code as an ACP agent for Coda over standard input and output; no terminal UI.\n');
} else {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  for (const name of ['query', 'getSessionInfo', 'renameSession']) {
    if (typeof sdk[name] !== 'function') throw new Error(`Claude SDK 缺少所需接口：${name}`);
  }
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    // A Claude process must not outlive this one even if closing the SDK hangs; the session host has a shorter grace of its own.
    setTimeout(() => process.exit(code || 1), 5000).unref();
    try { await session.close(); } finally { process.stdout.write('', () => process.exit(code)); }
  };
  const session = new ClaudeSession({ sdk, onEnded: () => void stop(1) });
  session.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed.then(() => stop());
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => void stop());
}
