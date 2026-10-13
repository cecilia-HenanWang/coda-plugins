// A manager account in Codex for one question: an app-server of its own in a home of its own, handed the account's tokens
// and checked to have taken that account, closed and removed after.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from './app-server.mjs';

export async function withAccount(tokens, work, { makeServer = options => new AppServer(options) } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-codex-account-'));
  const server = makeServer({ env: { ...process.env, CODEX_HOME: home } });
  try {
    await server.initialize();
    await server.request('account/login/start', { type: 'chatgptAuthTokens', ...tokens });
    const { account, workspaceRouting } = await server.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt' || workspaceRouting?.chatgptAccountId !== tokens.chatgptAccountId) throw new Error('Codex 登录后的账号与所选的不符');
    return await work(server);
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
}
