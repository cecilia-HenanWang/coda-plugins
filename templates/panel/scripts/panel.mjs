// 「运行时间」面板的取数命令：Coda 在打开资源页或点「刷新」时用 `sh -c` 运行它，标准输出就是面板 JSON
// （docs/plugins.md「面板」）。`node` 是 Coda 后端自己的 Node；只用 Node 自带的模块。
// 读不懂的键或类型会让这次读取失败，所以输出只用面板认识的几种项：card、meter、stat、button。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';

// `uptime` 的负载在 macOS 写作「load averages: 1.2 1.3 1.4」，在 Linux 写作「load average: 1.2, 1.3, 1.4」；读不到就用 Node 的。
function loads() {
  try {
    const line = execFileSync('uptime', { encoding: 'utf8', timeout: 5000 });
    const found = /load averages?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/.exec(line);
    if (found) return found.slice(1, 4).map(Number);
  } catch {}
  return loadavg();
}
const since = seconds => {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
};
// 按钮动作记下的时刻，存在插件的状态目录里（CODA_PLUGIN_STATE，跨读取、跨版本保留）。
function marked() {
  try { return JSON.parse(readFileSync(join(process.env.CODA_PLUGIN_STATE, 'mark.json'), 'utf8')).at; } catch { return null; }
}

const [one, five, fifteen] = loads(), cores = cpus().length, up = uptime(), mark = marked();
const items = [
  { type: 'button', label: '记下此刻', action: 'mark' },
  // 进度条一律画「还剩多少」：这里是 CPU 按 1 分钟负载算的余量；不知道比例时不写 fraction。
  { type: 'meter', label: 'CPU 余量（1 分钟负载）', value: `${one.toFixed(2)} / ${cores} 核`, fraction: Math.max(0, Math.min(1, 1 - one / cores)),
    note: `5 分钟 ${five.toFixed(2)}，15 分钟 ${fifteen.toFixed(2)}`, time: new Date(Date.now() - up * 1000).toISOString(), timeLabel: '开机' },
  ...(mark ? [{ type: 'stat', label: '距上次记下', value: since((Date.now() - Date.parse(mark)) / 1000) }] : []),
];
process.stdout.write(JSON.stringify({ items: [{ type: 'card', title: '运行时间', subtitle: `已开机 ${since(up)}`, items }] }));
