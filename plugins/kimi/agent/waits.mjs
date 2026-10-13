// Kimi's tasks, as its files show them (observe.mjs), told to Coda as waits of its own (docs/agent-protocol.md「_coda/wait」):
// a command as a task, a subagent's run as a subagent whose session is its agent id. A task Kimi will be told of when it ends
// is handled from its end until the main agent ends a turn after it, which is the turn Kimi works on it in; one it is not
// told of ends as it ends. Only tasks started since this agent process started (`startedAt`) are followed: an earlier
// process's are not told again. Coda cannot stop any of them.
const FINAL = { completed: 'done', failed: 'failed', killed: 'cancelled', lost: 'failed', timed_out: 'failed' };
const open = state => state === 'waiting' || state === 'handling';

export class KimiWaits {
  constructor({ sessionId, startedAt = 0 }) { this.sessionId = sessionId; this.startedAt = startedAt; this.said = new Map(); this.held = new Map(); }
  get handling() { return [...this.said.values()].filter(state => state === 'handling').length; }
  // What changed since last said, given what the files say now (`facts`) and what the subagents said meanwhile (`content`,
  // updates of their sessions, each with the run it is of): run by run as they began, what it is or became, what was said in
  // it, and its end. A subagent's later run is told once those before it have ended, so that it continues their card; what
  // it said meanwhile is kept until then, all of it: what was read is not read again, and it is no more than the run's wire
  // holds (subagents.mjs reads at most 32 MiB of it).
  read({ tasks, turnEndedAt }, content = []) {
    const runs = new Map(), going = new Set(), later = new Set();
    for (const task of tasks.filter(task => Number.isSafeInteger(task.startedAt) && task.startedAt >= this.startedAt).sort((a, b) => a.startedAt - b.startedAt)) {
      const run = { told: [], content: [], ended: [] }, subagent = task.kind === 'agent' && typeof task.agentId === 'string';
      runs.set(task.taskId, run);
      const before = this.said.get(task.taskId);
      if (before !== undefined && !open(before)) continue;
      if (before === undefined && subagent && going.has(task.agentId)) { later.add(task.taskId); continue; }
      const state = task.status === 'running' ? 'waiting'
        : task.terminalNotificationSuppressed === true || turnEndedAt >= (task.endedAt ?? 0) ? FINAL[task.status] ?? 'failed' : 'handling';
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
    return [...earlier.map(update), ...[...runs.values()].flatMap(run => [...run.told.map(wait), ...run.content.map(update), ...run.ended.map(wait)])];
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
