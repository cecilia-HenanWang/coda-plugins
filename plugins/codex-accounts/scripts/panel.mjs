// The「Codex 多账号」panel, printed once as `{ items }`. Quota failures stay on the affected account's card.
import { list, selection, withManagedAccount } from './manager.mjs';
import { panel } from './quota.mjs';

try {
  const read = account => withManagedAccount(account.identity, server => server.request('account/rateLimits/read'));
  console.log(JSON.stringify(await panel(await list(), selection(), read)));
} catch (error) { console.error(error.message); process.exit(1); }
