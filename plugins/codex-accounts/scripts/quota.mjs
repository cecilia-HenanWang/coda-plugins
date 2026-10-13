// What the「Codex 多账号」panel shows (docs/plugins.md「内置插件：Codex 多账号」): a card for this machine's own login and one for
// each manager account. The windows and full resets are drawn as the codex plugin's own panel draws them (its
// scripts/quota.mjs, of which this is the part a manager account needs). Kept apart from the commands so the tests can
// hand it answers.
import { NATIVE } from './manager.mjs';

const CARD_ITEMS = 20, ACCOUNTS = 40, BYTES = 60 * 1024;
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
const unixTime = value => typeof value === 'number' && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
export function utc8(seconds) {
  const d = new Date(seconds * 1000 + 8 * 3600_000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
export function windows(result) {
  const byID = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [];
  const limits = (byID.length ? byID : [result?.rateLimits]).filter(Boolean);
  return limits.flatMap(limit => ['primary', 'secondary'].flatMap(key => {
    const w = limit[key]; if (!w) return [];
    const minutes = w.windowDurationMins;
    const duration = minutes === 300 ? '5 小时' : minutes === 10080 ? '7 天' : Number.isSafeInteger(minutes) && minutes > 0 ? `${minutes} 分钟` : '额度';
    const used = typeof w.usedPercent === 'number' && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : null;
    const left = used === null ? null : Math.round(100 - used), resets = unixTime(w.resetsAt);
    return [{ type: 'meter', label: `${limits.length > 1 ? `${line(limit.limitName ?? limit.limitId, 40) || '额度'} · ` : ''}${duration}`,
      ...(left === null ? {} : { value: `剩余 ${left}%`, fraction: left / 100 }),
      ...(resets ? { time: resets, timeLabel: '重置' } : {}) }];
  }));
}
function credits(result) {
  const summary = result?.rateLimitResetCredits;
  if (!Number.isSafeInteger(summary?.availableCount)) return null;
  const listed = (summary.credits ?? []).filter(c => c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { count: summary.availableCount, listed };
}

// The choice of an account on its title row: the one in use says so and cannot be pressed.
const choice = (account, chosen) => chosen
  ? { type: 'button', label: '当前使用', action: 'select', args: { account }, disabled: true }
  : { type: 'button', label: '切换使用', action: 'select', args: { account } };

// A manager account's card, from its quota (`result`) or why it could not be read (`error`).
export function card(account, chosen, { result, error }) {
  const name = line(account.alias), buttons = [choice(account.identity, chosen)], items = [];
  if (error) items.push({ type: 'error', text: `暂时无法获取额度：${error}` });
  else {
    items.push(...windows(result));
    const resets = credits(result);
    if (resets) {
      const first = resets.listed[0];
      if (first && resets.count > 0) buttons.push({ type: 'button', label: '使用完全重置', action: 'reset', args: { account: account.identity, creditId: first.id },
        confirm: `使用 ${line(name, 60)} 的完全重置？\n用最早到期的那一次（${first.expiresAt == null ? '不会过期' : `${utc8(first.expiresAt)} 到期，UTC+8`}）。成功后消耗 1 次，无法撤销。` });
      const room = CARD_ITEMS - buttons.length - items.length - 1;
      items.push({ type: 'stat', label: '完全重置', value: `剩余 ${resets.count} 次` },
        ...resets.listed.slice(0, Math.max(0, room)).map((c, i) => ({ type: 'stat', label: `第 ${i + 1} 次`, value: c.expiresAt == null ? '不会过期' : `${utc8(c.expiresAt)} 到期` })));
    }
    if (!items.length) items.push({ type: 'error', text: '暂时无法获取额度：Codex 没有给出额度窗口' });
  }
  return { type: 'card', title: name, ...(line(account.plan) ? { subtitle: line(account.plan) } : {}), items: [...buttons, ...items].slice(0, CARD_ITEMS) };
}

// The panel: nothing without a manager. This machine's own login first (in use while nothing else was chosen; its quota is
// the「Codex」panel's), then the manager's accounts in its order, each read by `read(account)`, a few at a time.
export async function panel(accounts, chosen, read, { at = 4 } = {}) {
  if (!accounts) return { items: [] };
  const shown = accounts.slice(0, ACCOUNTS), cards = new Array(shown.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(at, shown.length) }, async () => {
    for (let i; (i = next++) < shown.length;) {
      const account = shown[i];
      let reading;
      try { reading = { result: await read(account) }; } catch (error) { reading = { error: error.message }; }
      cards[i] = card(account, chosen === account.identity, reading);
    }
  }));
  const items = [{ type: 'card', title: '本机登录', items: [choice(NATIVE, chosen === null || chosen === NATIVE),
    { type: 'markdown', text: '这台机器上 Codex 自己的登录，额度见「Codex」面板' }] }];
  // Within what a panel may print (64 KiB), with room for the line counting those left out.
  let bytes = Buffer.byteLength(JSON.stringify(items));
  for (const each of cards) {
    const size = Buffer.byteLength(JSON.stringify(each)) + 1;
    if (bytes + size > BYTES) break;
    items.push(each); bytes += size;
  }
  const left = accounts.length - (items.length - 1);
  return { items: [...items, ...(left > 0 ? [{ type: 'markdown', text: `另有 ${left} 个账号没有列出` }] : [])] };
}
export const outcomes = { nothingToReset: '当前额度无需重置', alreadyRedeemed: '这次重置已被使用', noCredit: '这次重置已不可用' };
