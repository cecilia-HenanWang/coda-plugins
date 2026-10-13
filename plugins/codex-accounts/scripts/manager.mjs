// The codex-account manager this plugin reads (docs/plugins.md「内置插件：Codex 多账号」), and the choice it keeps: which of
// its accounts Codex uses, or this machine's own login. Credentials are read under the manager's lock by manager.py, whose
// output is never logged; neither they nor refresh tokens are copied anywhere.
import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE = 'native';
export const paths = (env = process.env) => ({
  accounts: env.CODA_CODEX_ACCOUNTS || join(homedir(), '.local/state/cockpit-codex-account'),
  // The manager's active account lives in Codex's own home, which is also this machine's own login.
  native: env.CODEX_HOME || join(homedir(), '.codex'),
});
const unavailable = '账号凭据不可用，请在账号管理器更新登录后重试';
function manager(args, at) {
  return new Promise((resolve, reject) => {
    execFile('python3', [fileURLToPath(new URL('manager.py', import.meta.url)), at.accounts, at.native, ...args], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(new Error(error.code === 2 ? '账号管理器正在更新，请稍后重试'
          : args[0] === NATIVE ? '本机登录的凭据读不到（已过期，或存在系统钥匙串里），在「Codex」面板重新登录' : unavailable));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(unavailable)); }
      });
  });
}
// The manager's accounts: `{ alias, identity, plan, active }`, identity being an opaque digest of the account's ID. None
// without a manager on this machine.
export async function list(at = paths()) {
  try { readFileSync(join(at.accounts, 'registry.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`读不了账号管理器：${error.code ?? error.message}`); }
  return manager(['list'], at);
}
// An account's tokens, checked to be the account the identity names. `native` is this machine's own login.
export const tokens = (account, at = paths()) => account === NATIVE ? manager([NATIVE], at)
  : list(at).then(accounts => {
    const found = accounts?.find(a => a.identity === account);
    if (!found) throw new Error('账号管理器里已没有这个账号');
    return manager(['read', found.alias, found.identity], at);
  });

// The choice, in this plugin's state: `{ account }`, an identity or `native`; none while nothing was chosen.
const selectionFile = (env = process.env) => join(env.CODA_PLUGIN_STATE, 'selection.json');
export function selection(env = process.env) {
  try { return JSON.parse(readFileSync(selectionFile(env), 'utf8')).account ?? null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('读不了所选的账号'); }
}
export function choose(account, env = process.env) {
  const file = selectionFile(env), temp = `${file}.${process.pid}`;
  writeFileSync(temp, JSON.stringify({ account }), { mode: 0o600 }); renameSync(temp, file);
}
