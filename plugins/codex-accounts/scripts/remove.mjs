import { remove } from './manager.mjs';

try { await remove(JSON.parse(process.env.CODA_PANEL_ARGS || '{}').account); }
catch (error) { console.error(error.message); process.exitCode = 1; }
