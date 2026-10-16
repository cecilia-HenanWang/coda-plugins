// Kimi's tasks, as its files show them (observe.mjs), told to Coda as waits of its own (docs/agent-protocol.md「_coda/wait」):
// a command as a task, a subagent's run as a subagent whose session is its agent id, a cron as a timer. A task ending during
// Coda's prompt ends there: the main agent is already handling it in that turn. One ending outside a prompt is handled until
// the main agent ends a turn after it; one it is not told of ends as it ends. Only tasks started since this agent process
// started (`startedAt`) are followed: an earlier process's are not told again. A cron is told whenever it is seen, including
// one set before this process: telling `waiting` again does not register a second one. One first seen already finished is
// not registered. Its next fire follows the cursor and Kimi's offset (`nextFire`). Coda cannot stop any of them.
const FINAL = { completed: 'done', failed: 'failed', killed: 'cancelled', lost: 'failed', timed_out: 'failed' };
const open = state => state === 'waiting' || state === 'handling';

export class KimiWaits {
  constructor({ sessionId, startedAt = 0, now = () => Date.now() }) {
    this.sessionId = sessionId; this.startedAt = startedAt; this.now = now; this.said = new Map(); this.held = new Map(); this.at = new Map();
  }
  get handling() { return [...this.said.values()].filter(state => state === 'handling').length; }
  // What changed since last said, given what the files say now (`facts`) and what the subagents said meanwhile (`content`,
  // updates of their sessions, each with the run it is of): run by run as they began, what it is or became, what was said in
  // it, and its end. A subagent's later run is told once those before it have ended, so that it continues their card; what
  // it said meanwhile is kept until then, all of it: what was read is not read again, and it is no more than the run's wire
  // holds (subagents.mjs reads at most 32 MiB of it).
  read({ tasks, turnEndedAt, crons = [], schedule = {} }, content = [], { promptActive = false } = {}) {
    const runs = new Map(), going = new Set(), later = new Set();
    for (const task of tasks.filter(task => Number.isSafeInteger(task.startedAt) && task.startedAt >= this.startedAt).sort((a, b) => a.startedAt - b.startedAt)) {
      const run = { told: [], content: [], ended: [] }, subagent = task.kind === 'agent' && typeof task.agentId === 'string';
      runs.set(task.taskId, run);
      const before = this.said.get(task.taskId);
      if (before !== undefined && !open(before)) continue;
      if (before === undefined && subagent && going.has(task.agentId)) { later.add(task.taskId); continue; }
      const state = task.status === 'running' ? 'waiting'
        : task.terminalNotificationSuppressed === true || promptActive || turnEndedAt >= (task.endedAt ?? 0)
          ? FINAL[task.status] ?? 'failed' : 'handling';
      if (subagent && open(state)) going.add(task.agentId);
      if (state === before) continue;
      this.said.set(task.taskId, state);
      // What it is is said as it is first told: one first seen ended is told begun, so that what its subagent said is its own.
      if (before === undefined) run.told.push({ sessionId: this.sessionId, waitId: task.taskId, state: open(state) ? state : 'waiting',
        kind: subagent ? 'subagent' : 'task', title: String(task.description || (subagent ? '子 Agent' : '后台任务')).slice(0, 500), stoppable: false,
        ...(subagent ? { childSessionId: task.agentId } : {}), ...(typeof task.model === 'string' ? { model: task.model.slice(0, 200) } : {}) });
      if (before === undefined) { run.content.push(...this.held.get(task.taskId) ?? []); this.held.delete(task.taskId); }
      if (!open(state)) run.ended.push({ sessionId: this.sessionId, waitId: task.taskId, state });
      else if (before !== undefined) run.told.push({ sessionId: this.sessionId, waitId: task.taskId, state });
    }
    // What was said in no run told here is of runs told before.
    const earlier = [];
    for (const said of content) {
      if (!later.has(said.taskId)) { (runs.get(said.taskId)?.content ?? earlier).push(said); continue; }
      if (!this.held.has(said.taskId)) this.held.set(said.taskId, []);
      this.held.get(said.taskId).push(said);
    }
    const update = ({ update, sessionId }) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    return [...earlier.map(update), ...[...runs.values()].flatMap(run => [...run.told.map(wait), ...run.content.map(update), ...run.ended.map(wait)]),
      ...this.scheduled(crons, schedule)];
  }
  // Crons as the wire left them (`phase`): waiting, handling, done or cancelled. Done and cancelled are that wire fact,
  // not the id having left the list. While it stays waiting, a new fire cursor still moves the next time.
  scheduled(crons, schedule = {}) {
    const told = [], asOf = Number.isFinite(schedule.asOf) ? schedule.asOf : this.now(), reliable = schedule.reliable !== false;
    for (const cron of crons) {
      if (cron.phase !== 'waiting' && cron.phase !== 'handling' && cron.phase !== 'done' && cron.phase !== 'cancelled') continue;
      const before = this.said.get(cron.id);
      if ((before !== undefined && !open(before)) || (before === undefined && !open(cron.phase))) continue;
      const at = cron.phase === 'waiting' && reliable ? nextFire(cron, asOf, schedule.noJitter === true) : null;
      const atIso = at === null ? '' : new Date(at).toISOString();
      if (cron.phase === before && (cron.phase !== 'waiting' || atIso === this.at.get(cron.id))) continue;
      this.said.set(cron.id, cron.phase);
      if (cron.phase === 'waiting') this.at.set(cron.id, atIso);
      const time = atIso === '' ? {} : { at: atIso };
      told.push(before === undefined
        ? wait({ sessionId: this.sessionId, waitId: cron.id, state: cron.phase, kind: 'timer', title: String(cron.title || '定时检查').slice(0, 500),
          detail: String(cron.schedule ?? '').slice(0, 4000), recurring: cron.recurring === true, stoppable: false, ...time })
        : wait({ sessionId: this.sessionId, waitId: cron.id, state: cron.phase, ...time }));
    }
    return told;
  }
  // The files no longer read as understood: nothing will tell how what was waited on ended, so it ends.
  lost() {
    const ended = [...this.said].filter(([, state]) => open(state));
    this.held.clear();
    for (const [waitId] of ended) this.said.set(waitId, 'failed');
    return ended.map(([waitId]) => wait({ sessionId: this.sessionId, waitId, state: 'failed' }));
  }
}
const wait = params => ({ jsonrpc: '2.0', method: '_coda/wait', params });

// The next time Kimi 2.1.1 will fire `cron`, counted from the later of `createdAt` and a cursor `lastFiredAt` that is not
// still in the future (`now`), not from `now` itself: resuming inside the offset must not skip to the period after.
// Then the default offset, unless `noJitter`. Recurring waits by the id's fraction, at most 10% of the period and 15
// minutes. A one-shot on local minute 0 or 30, when that minute is a UTC minute, comes forward by up to 90 seconds,
// unless that would be before it was created. Null when the expression has no next minute within five years.
export function nextFire(cron, now = Date.now(), noJitter = false) {
  const { id, schedule, recurring, createdAt, lastFiredAt } = cron ?? {};
  if (typeof id !== 'string' || !Number.isFinite(createdAt)) return null;
  const seeded = Number.isFinite(lastFiredAt) && lastFiredAt <= now && lastFiredAt > createdAt ? lastFiredAt : createdAt;
  const ideal = nextRun(schedule, seeded);
  if (ideal === null || noJitter === true) return ideal;
  if (recurring === false) return oneShotAt(id, ideal, createdAt);
  const cap = delayCap(schedule, ideal);
  return cap > 0 ? ideal + cap * fractionFromId(id) : ideal;
}
function fractionFromId(id) {
  if (/^[0-9a-f]{8}$/i.test(id)) {
    const n = Number.parseInt(id, 16);
    if (Number.isFinite(n)) return n / 4294967296;
  }
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = (hash << 5) + hash + id.charCodeAt(i) | 0;
  return (hash >>> 0) / 4294967296;
}
function delayCap(schedule, ideal) {
  const next = nextRun(schedule, ideal);
  const period = next !== null && next > ideal ? next - ideal : 1_440 * 60_000;
  return Math.min(period * 0.1, 15 * 60_000);
}
function oneShotAt(id, ideal, createdAt) {
  if (ideal % 60_000 !== 0) return ideal;
  const minute = new Date(ideal).getMinutes();
  if (minute !== 0 && minute !== 30) return ideal;
  const shifted = ideal - 90_000 * fractionFromId(id);
  return shifted < createdAt ? ideal : shifted;
}

// The next minute after `from` a five-field cron schedule matches, in local time (as Kimi schedules on this machine);
// null when it cannot be read or never matches within five years.
export function nextRun(schedule, from = Date.now()) {
  const fields = typeof schedule === 'string' ? schedule.trim().split(/\s+/) : [];
  if (fields.length !== 5) return null;
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => values(field, ...[[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][i]));
  if (![minutes, hours, days, months, weekdays].every(Boolean)) return null;
  if (weekdays.has(7)) weekdays.add(0);
  // Both day fields restricted: either matches.
  const day = date => fields[2] === '*' ? fields[4] === '*' || weekdays.has(date.getDay())
    : fields[4] === '*' ? days.has(date.getDate()) : days.has(date.getDate()) || weekdays.has(date.getDay());
  const t = new Date(from); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1);
  for (const limit = from + 5 * 366 * 86_400_000; t.getTime() < limit;) {
    if (!months.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); }
    else if (!day(t)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); }
    else if (!hours.has(t.getHours())) t.setHours(t.getHours() + 1, 0, 0, 0);
    else if (!minutes.has(t.getMinutes())) t.setMinutes(t.getMinutes() + 1, 0, 0);
    else return t.getTime();
  }
  return null;
}
function values(field, min, max) {
  const set = new Set();
  for (const part of field.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const low = m[1] ? min : Number(m[2]), high = m[1] ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : low, step = m[4] ? Number(m[4]) : 1;
    if (low < min || high > max || low > high || step < 1) return null;
    for (let v = low; v <= high; v += step) set.add(v);
  }
  return set;
}
