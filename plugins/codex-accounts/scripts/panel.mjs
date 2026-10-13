// The「Codex 多账号」panel's reading, printed once as `{ items }`. A manager that cannot be read fails the reading, which
// keeps the last one shown; an account whose quota cannot be read says so on its own card.
import { withAccount } from './codex.mjs';
import { list, selection, tokens } from './manager.mjs';
import { panel } from './quota.mjs';

try {
  const read = async account => withAccount(await tokens(account.identity), server => server.request('account/rateLimits/read'));
  console.log(JSON.stringify(await panel(await list(), selection(), read)));
} catch (error) { console.error(error.message); process.exit(1); }
