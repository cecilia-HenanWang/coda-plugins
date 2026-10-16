// Kimi's tasks, as its files show them (observe.mjs), told to Coda as waits of its own (docs/agent-protocol.md「_coda/wait」):
// a command as a task, a subagent's run as a subagent whose session is its agent id, a cron as a timer. A task ending during
// Coda's prompt ends there: the main agent is already handling it in that turn. One ending outside a prompt is handled until
// the main agent ends a turn after it; one it is not told of ends as it ends. Only tasks started since this agent process
// started (`startedAt`) are followed: an earlier process's are not told again. A cron still on the schedule is told whenever
// it is seen, including one set before this process: telling `waiting` again does not register a second one. One first seen
// already finished is not registered. Coda cannot stop any of them.
const FINAL = { completed: 'done', failed: 'failed', killed: 'cancelled', lost: 'failed', timed_out: 'failed' };
const open = state => state === 'waiting' || state === 'handling';

export class KimiWaits {
  constructor({ sessionId, startedAt = 0, now = () => Date.now() }) {
    this.sessionId = sessionId; this.startedAt = startedAt; this.now = now; this.said = new Map(); this.held = new Map(); this.timers = new Set();
  }
  get handling() { return [...this.said.values()].filter(state => state === 'handling').length; }
  // What changed since last said, given what the files say now (`facts`) and what the subagents said meanwhile (`content`,
  // updates of their sessions, each with the run it is of): run by run as they began, what it is or became, what was said in
  // it, and its end. A subagent's later run is told once those before it have ended, so that it continues their card; what
  // it said meanwhile is kept until then, all of it: what was read is not read again, and it is no more than the run's wire
  // holds (subagents.mjs reads at most 32 MiB of it).
  read({ tasks, turnEndedAt, crons = [] }, content = [], { promptActive = false } = {}) {
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
      ...this.scheduled(crons)];
  }
  // Crons still scheduled or firing (`phase`), and one that left that list: its fire turn ended, so a one-shot is done.
  // A recurring one stays in the list and is waiting again, with its next time. `at` is that next minute in local time.
  scheduled(crons) {
    const told = [], live = new Set();
    for (const cron of crons) {
      if (cron.phase !== 'waiting' && cron.phase !== 'handling') continue;
      live.add(cron.id); this.timers.add(cron.id);
      const before = this.said.get(cron.id);
      if ((before !== undefined && !open(before)) || cron.phase === before) continue;
      this.said.set(cron.id, cron.phase);
      const at = cron.phase === 'waiting' ? nextRun(cron.schedule, this.now()) : null;
      told.push(before === undefined
        ? wait({ sessionId: this.sessionId, waitId: cron.id, state: cron.phase, kind: 'timer', title: String(cron.title || '定时检查').slice(0, 500),
          detail: String(cron.schedule ?? '').slice(0, 4000), recurring: cron.recurring === true, stoppable: false,
          ...(at === null ? {} : { at: new Date(at).toISOString() }) })
        : wait({ sessionId: this.sessionId, waitId: cron.id, state: cron.phase, ...(at === null ? {} : { at: new Date(at).toISOString() }) }));
    }
    for (const id of this.timers) {
      if (live.has(id)) continue;
      const before = this.said.get(id);
      if (before === undefined || !open(before)) continue;
      this.said.set(id, 'done');
      told.push(wait({ sessionId: this.sessionId, waitId: id, state: 'done' }));
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
