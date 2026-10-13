// The panel's「切换使用」: an account is first signed in to on its own, and chosen only if that works; this machine's own
// login is chosen as it is. Sessions take the choice at their next boundary (the codex plugin's account bridge).
import { withAccount } from './codex.mjs';
import { NATIVE, choose, tokens } from './manager.mjs';

const { account } = JSON.parse(process.env.CODA_PANEL_ARGS || '{}');
try {
  if (typeof account !== 'string' || !account) throw new Error('没有指明切换到哪个账号');
  if (account !== NATIVE) await withAccount(await tokens(account), async () => {});
  choose(account);
} catch (error) { console.error(`切换失败：${error.message}`); process.exit(1); }
