// Once an account source owns the accounts, even the pre-existing Codex login entry adds to its managed store.
import { spawn } from 'node:child_process';
import { accountSource, sourceEnv } from '../agent/account-source.mjs';

const source = accountSource();
if (source && process.argv[2] === 'login') {
  const child = spawn('/bin/sh', ['-c', `${source.command} --login`], { env: sourceEnv(source), stdio: 'inherit' });
  process.on('SIGTERM', () => child.kill('SIGTERM')); process.on('SIGINT', () => child.kill('SIGINT'));
  child.on('error', () => { console.error('无法启动账号插件的登录'); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
} else await import('@openai/codex/bin/codex.js');
