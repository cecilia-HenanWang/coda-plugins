// What this plugin plugs into Codex's `account-source` point: started by a Codex session's account bridge and asked over
// standard input and output, one JSON object a line, as the codex plugin's agent/account-source.mjs says. The choice is
// read anew each time it is asked, so a switch on the resources page reaches the session at its next boundary.
import { readLines } from './lines.mjs';
import { NATIVE, list, selection, tokens } from './manager.mjs';

async function selected() {
  const account = selection();
  if (account === null) return { account: null };
  if (account === NATIVE) return { account: { id: NATIVE, name: '本机登录' } };
  const found = (await list())?.find(a => a.identity === account);
  if (!found) throw new Error('所选的账号已不在账号管理器里');
  return { account: { id: account, name: found.alias } };
}
const answer = message => message.method === 'selected' ? selected()
  : message.method === 'tokens' && typeof message.params?.account === 'string' ? tokens(message.params.account)
  : Promise.reject(new Error(`不认识的请求：${message.method}`));

readLines(process.stdin).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message?.id === undefined) return;
  answer(message).then(result => ({ id: message.id, result }), error => ({ id: message.id, error: { message: error.message } }))
    .then(reply => process.stdout.write(`${JSON.stringify(reply)}\n`));
});
// Its input closed (the bridge has gone), it ends once what it was asked is answered.
