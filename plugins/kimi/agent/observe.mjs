import { constants, watch } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { KimiSubagentBridge } from './subagents.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[\w-]+$/.test(value);
const unread = () => null;

// What Kimi keeps of a session in its own files (KIMI_CODE_HOME): its tasks, its main agent's turns, the crons it scheduled
// (`cron.add` / `cron.delete` on the main wire) and its subagents' own conversations, which its ACP does not tell. These
// files are an implementation detail, not an ACP contract. Accept only the layout inspected in 2.1.1; a new version simply
// loses this observation.
export const SUPPORTED = '2.1.1';
// Bounded ordinary-file reads also prevent a broken index/FIFO from holding up
// the entry. No paths, prompts, task output or credentials leave this module.
async function read(path, limit, signal) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported file');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error('File changed during observation');
    return buffer.toString('utf8', 0, length);
  } finally { await file.close(); }
}
async function contained(root, path) {
  const actual = await realpath(path), rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Foreign path');
  return actual;
}

// The session `sessionId` that Kimi keeps for `cwd`. `startedAt`: when this agent process started; a subagent's run from
// before it is another process's, whose conversation is not told again.
export function kimiSession({ sessionId, cwd, env = {}, version, startedAt = 0 }) {
  const home = env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code');
  let directory;
  let subagents;
  return {
  // Calls `changed` whenever the session's files may have changed, and once its watches are in place; `lost` if one
  // breaks. Its directory is watched whole; its main agent's wire is a file appended to, whose watch (that of a file) is
  // in place once the event loop has polled after it was asked for, so the main turn's end is heard even before the
  // directory's watch has begun. Nothing is watched before an observation found the directory.
  watch(changed, lost) {
    if (!directory) return null;
    const watchers = [];
    let closed = false;
    const close = () => { closed = true; for (const watcher of watchers) watcher.close(); };
    const follow = (path, options) => {
      const watcher = watch(path, options, () => { if (!closed) changed(); });
      watcher.on('error', () => { if (closed) return; close(); lost(); });
      watcher.unref();
      watchers.push(watcher);
    };
    try { follow(directory, { recursive: true }); } catch { close(); return null; }
    try { follow(join(directory, 'agents/main/wire.jsonl'), {}); } catch {}
    setImmediate(() => setImmediate(() => { if (!closed) changed(); }));
    return { close };
  },
  // What the files say now: every task record of its agents and the subagent runs its main agent's wire tells of (`tasks`),
  // when its main agent last ended a turn (`turnEndedAt`, 0 for never), the crons still on its schedule or firing (`crons`,
  // each `waiting` or `handling`; one whose fire turn already ended is left out), and what its subagents said since the last
  // look, to `emit` as their own sessions' updates. A cron's prompt does not leave here, only a short title cut from its
  // first line. Null when the files are not this session's, or not laid out as understood; a read that fails (a file being
  // written) throws. A cron event that is not the shape understood is skipped, so one of them cannot hide the tasks.
  async observe({ signal, emit = () => {} }) {
    if (version !== SUPPORTED) return unread('unsupported_version');
    if (!identifier(sessionId) || !isAbsolute(home ?? '') || !isAbsolute(cwd ?? '')) return unread('unbound_session');
    const root = await realpath(join(home, 'sessions')), workspace = await realpath(cwd);
    if (!directory) {
      const index = await read(join(home, 'session_index.jsonl'), 16 * 1024 * 1024, signal);
      let match;
      for (const line of index.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.sessionId === sessionId) match = entry;
      }
      if (!match || typeof match.sessionDir !== 'string' || typeof match.workDir !== 'string' ||
        await realpath(match.workDir) !== workspace) return unread('unbound_session');
      directory = await contained(root, match.sessionDir);
    }
    const session = await contained(root, directory);
    const state = JSON.parse(await read(join(session, 'state.json'), 1024 * 1024, signal));
    if (state.version !== 2 || state.id !== sessionId || typeof state.cwd !== 'string' ||
      await realpath(state.cwd) !== workspace || !object(state.agents) || !object(state.agents.main)) return unread('unsupported_layout');
    const agents = Object.keys(state.agents);
    if (agents.length > 256 || !agents.every(identifier)) return unread('unsupported_layout');

    const records = [];
    for (const id of agents) {
      const agent = await contained(session, join(session, 'agents', id));
      let tasks;
      try { tasks = await contained(agent, join(agent, 'tasks')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const files = await readdir(tasks, { withFileTypes: true });
      if (files.length > 4096) return unread('unsupported_layout');
      for (const file of files) {
        signal.throwIfAborted();
        if (!file.name.endsWith('.json')) continue;
        if (!file.isFile()) return unread('unsupported_layout');
        const task = JSON.parse(await read(join(tasks, file.name), 1024 * 1024, signal));
        if (!object(task) || !identifier(task.taskId) || file.name !== `${task.taskId}.json` ||
          !['agent', 'process'].includes(task.kind) || typeof task.status !== 'string') return unread('unsupported_layout');
        if (task.status !== 'running' && (!['completed', 'failed', 'killed', 'lost', 'timed_out'].includes(task.status) ||
          !Number.isSafeInteger(task.endedAt) || task.endedAt <= 0)) return unread('unsupported_layout');
        records.push(task);
      }
    }

    subagents ??= new KimiSubagentBridge({ session, root, readBounded: read, contained, startedAt });
    let tasks = records;
    try { tasks = await subagents.sync({ agents, state, tasks: records, signal, emit }); } catch {}
    // A task's end can enqueue a notification that starts another main turn: what it ended with is handled once a turn of
    // the main agent ended after it.
    const wire = await read(join(session, 'agents/main/wire.jsonl'), 32 * 1024 * 1024, signal);
    const lines = wire.trimEnd().split('\n');
    const metadata = JSON.parse(lines.shift());
    if (metadata.type !== 'metadata' || metadata.protocol_version !== '1.5') return unread('unsupported_layout');
    // `cron.delete` is Kimi taking the job off the schedule as it fires, written just before that turn. A job still on the
    // schedule is waiting; one deleted whose fire turn has not ended is handling. One whose fire turn ended is left out.
    const crons = new Map();
    let turnId = null, turnEndedAt = 0;
    for (const line of lines) {
      signal.throwIfAborted();
      const event = JSON.parse(line);
      if (event.type === 'cron.add') noteCron(crons, event);
      else if (event.type === 'cron.delete') dropCron(crons, event);
      else if (event.type === 'agent.turn.started' || (event.type === 'turn.prompt' && event.agentId === 'main')) {
        turnId = event.turnId;
        if (event.type === 'turn.prompt') noteFire(crons, event);
      } else if (event.type === 'turn.ended') {
        if (event.agentId !== 'main' || event.turnId !== turnId || !['completed', 'cancelled', 'failed', 'blocked'].includes(event.reason) ||
          !Number.isSafeInteger(event.time) || event.time <= 0) return unread('unsupported_layout');
        turnEndedAt = event.time;
        for (const cron of crons.values()) if (cron.fireTurn === event.turnId) cron.fireEnded = true;
      }
    }
    return { tasks, turnEndedAt, crons: [...crons.values()].filter(cron => !cron.deletedAt || !cron.fireEnded).map(publishCron) };
  } };
}

// A cron.add that is not the shape from 2.1.1 is ignored. A later add of the same id replaces it.
function noteCron(crons, event) {
  const task = event.task;
  if (!object(task) || !identifier(task.id) || typeof task.cron !== 'string' || !task.cron.trim() || task.cron.length > 200 ||
    typeof task.recurring !== 'boolean' || !Number.isSafeInteger(task.createdAt) || task.createdAt <= 0) return;
  crons.set(task.id, { id: task.id, schedule: task.cron.trim(), recurring: task.recurring, title: cronTitle(task.prompt),
    deletedAt: undefined, fireTurn: undefined, fireEnded: false });
}
function dropCron(crons, event) {
  if (!Array.isArray(event.ids) || !Number.isSafeInteger(event.time) || event.time <= 0) return;
  for (const id of event.ids) { const cron = crons.get(id); if (cron) cron.deletedAt = event.time; }
}
function noteFire(crons, event) {
  const origin = event.origin;
  if (!object(origin) || origin.kind !== 'cron_job' || !identifier(origin.jobId)) return;
  const cron = crons.get(origin.jobId);
  if (!cron) return;
  cron.fireTurn = event.turnId;
  cron.fireEnded = false;
}
// The first clause of the prompt, without the command that follows it. Empty when there is nothing to show.
function cronTitle(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt.split(/\r?\n/, 1)[0].trim().split(/[`（(:：]/, 1)[0].trim().slice(0, 100);
}
function publishCron(cron) {
  return { id: cron.id, schedule: cron.schedule, recurring: cron.recurring, title: cron.title,
    phase: (cron.fireTurn !== undefined && !cron.fireEnded) || Number.isSafeInteger(cron.deletedAt) ? 'handling' : 'waiting' };
}
