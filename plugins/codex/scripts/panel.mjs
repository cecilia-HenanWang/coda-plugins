// An account source owns its quota panel. Without one, show Codex's own login as before.
import { withAppServer } from './app-server.mjs';
import { panel } from './quota.mjs';
import { accountSource } from '../agent/account-source.mjs';

try { console.log(JSON.stringify(accountSource() ? { items: [] } : await withAppServer(panel))); }
catch (error) { console.error(error.message); process.exit(1); }
