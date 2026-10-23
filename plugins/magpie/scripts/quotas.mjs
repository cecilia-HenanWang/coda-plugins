// The panel「Magpie 额度」: what is left of each subscription, plan and balance Magpie serves, as its gateway says
// (GET /v1/magpie/quotas), a card each — every one Magpie has, those Coda's own panels show too. A window is a bar of what
// is left and when it starts again, as the other plugins' panels say it (`剩余 N%`, `7 天`); a balance and the resets left
// are a line each; a reading that failed says why. A gateway that does not answer fails the reading, with why on standard error.
import { GATEWAY } from './setup.mjs';

const line = text => String(text).slice(0, 80);
const WORDS = { Monthly: '月度', Weekly: '7 天', Daily: '1 天' };
// A window's name as the other panels write one: `5 hours` is `5 小时`, `7 days` `7 天`; one of its own stays as Magpie says it.
const named = name => {
  const span = /^(\d+) (hour|day|week|month)s?$/.exec(name);
  return line(span ? `${span[1]} ${{ hour: '小时', day: '天', week: '周', month: '个月' }[span[2]]}` : WORDS[name] ?? name);
};

function meter(window) {
  if (window.unlimited) return { type: 'meter', label: named(window.name), value: '不限' };
  const left = Math.round(Math.min(100, Math.max(0, Number(window.remaining))));
  return { type: 'meter', label: named(window.name), value: `剩余 ${left}%`, fraction: left / 100,
    ...(window.resetsAt ? { time: window.resetsAt, timeLabel: '重置' } : {}) };
}

function card(quota) {
  const subtitle = [quota.plan, quota.alias || quota.user].filter(Boolean).join(' · ');
  const items = [...(quota.windows ?? []).map(meter),
    ...(quota.balance ? [{ type: 'stat', label: '余额', value: line(quota.balance) }] : []),
    ...(quota.resets?.count ? [{ type: 'stat', label: '可用重置', value: `${quota.resets.count} 次` }] : []),
    ...(quota.error ? [{ type: 'error', text: line(quota.error) }] : [])].slice(0, 20);
  return { type: 'card', title: line(quota.name || quota.provider), ...(subtitle ? { subtitle: line(subtitle) } : {}), items };
}

async function main() {
  let response;
  try { response = await fetch(`http://${GATEWAY}/v1/magpie/quotas`, { signal: AbortSignal.timeout(20_000) }); }
  catch { console.error(`Magpie 网关没有在 http://${GATEWAY} 应答`); process.exit(1); }
  if (!response.ok) { console.error(`Magpie 网关没能读出额度（HTTP ${response.status}）`); process.exit(1); }
  const { data } = await response.json();
  console.log(JSON.stringify({ items: (data ?? []).slice(0, 50).map(card) }));
}

await main();
