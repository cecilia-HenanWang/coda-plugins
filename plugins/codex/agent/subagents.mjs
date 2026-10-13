// Patches to the locked codex-acp for native subagent sessions. Each fails loudly once the adapter changes.
const patches = [
  // Codex continues a finished subagent with `followup_task`, which starts a new turn in its thread. The adapter
  // reopens a finished subagent only for `sendInput` and `resumeAgent`, so it drops everything that run does as
  // updates for a terminal subagent. Reopen it when its thread actually starts a turn: a queued `send_message`
  // reports the same "interacted" activity but runs nothing, and must not open a run nobody ends.
  ['    if (notification.method === "turn/started") {\n', before => `${before}      const codaThreadId = notification.params.threadId;
      if (codaThreadId !== this.rootSessionId && (this.children.get(codaThreadId)?.terminalState !== void 0 || this.terminalPendingSpawns.has(codaThreadId))) await this.reopen(codaThreadId);\n`],
];
export function continuedCodexSubagents(source) {
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp subagent patch no longer matches the locked adapter');
    source = source.replace(before, after(before));
  }
  return source;
}
