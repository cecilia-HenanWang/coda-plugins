// The「Grok」panel's reading, printed once as `{ items }`. No login file here shows nothing (the panel is then offered under
// 「添加资源」); a CLI that cannot be asked fails the reading, which keeps the last one shown.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { grokAsk, grokHome } from './ask.mjs';
import { panel } from './quota.mjs';

try { statSync(join(grokHome(), 'auth.json')); }
catch (error) { if (error.code === 'ENOENT') { console.log('{"items":[]}'); process.exit(0); } console.error(`读不了 Grok 的登录：${error.code}`); process.exit(1); }
try { console.log(JSON.stringify(panel(await grokAsk(['_x.ai/auth/check_subscription', '_x.ai/auth/info', '_x.ai/billing'])))); }
catch (error) { console.error(error.message); process.exit(1); }
