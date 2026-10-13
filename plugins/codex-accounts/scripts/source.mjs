// What this plugin plugs into Codex's `account-source` point: started by a Codex session's account bridge and asked over
// standard input and output, one JSON object a line, as the codex plugin's agent/account-source.mjs says. The choice is
// read anew each time it is asked, so a switch on the resources page reaches the session at its next boundary.
import { readLines } from './lines.mjs';
import { list, selection, tokens } from './manager.mjs';

async function selected() {
  const accounts = await list(), account = selection();
  if (account === null) throw new Error('请在「Codex 多账号」添加或选择一个账号');
  const found = accounts.find(a => a.identity === account);
  if (!found) throw new Error('所选账号尚未在插件中登录，请在「Codex 多账号」重新登录该账号');
  return { account: { id: account, name: found.alias } };
}
const answer = message => message.method === 'selected' ? selected()
  : message.method === 'tokens' && typeof message.params?.account === 'string' ? tokens(message.params.account, undefined, { refresh: message.params.refresh === true })
  : Promise.reject(new Error(`不认识的请求：${message.method}`));

// The native Codex login entry delegates here while this source owns its accounts.
if (process.argv.includes('--login')) await import('./login.mjs');
else readLines(process.stdin).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message?.id === undefined) return;
  answer(message).then(result => ({ id: message.id, result }), error => ({ id: message.id, error: { message: error.message } }))
    .then(reply => process.stdout.write(`${JSON.stringify(reply)}\n`));
});
// Its input closed (the bridge has gone), it ends once what it was asked is answered.
