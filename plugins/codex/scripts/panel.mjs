// The Codex panel's reading: this machine's Codex login and its quota, printed once as `{ items }`. Codex not answering
// fails the reading, which keeps the last one shown.
import { withAppServer } from './app-server.mjs';
import { panel } from './quota.mjs';

try { console.log(JSON.stringify(await withAppServer(panel))); }
catch (error) { console.error(error.message); process.exit(1); }
