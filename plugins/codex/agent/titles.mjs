// Title generation is advisory. Wait for its publication before completion, but
// never let a stalled generator or a cancelled prompt hold the session open.
export async function settleTitle(work, { signal, timeout = 15000 } = {}) {
  if (signal?.aborted) return;
  let timer, abort;
  try {
    await Promise.race([
      Promise.resolve().then(work).catch(() => {}),
      new Promise(resolve => {
        timer = setTimeout(resolve, timeout);
        abort = resolve;
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// codex-acp 1.12.0 starts title generation without returning its promise. Keep
// this compatibility patch scoped to the locked bundle; fail visibly if its
// implementation changes, rather than silently restoring completion races.
export function orderedCodexTitles(source) {
  // Once execution has finished, stopping the advisory title wait must not
  // turn the completed prompt or its file-change report into a cancellation.
  const replacements = [
    ['    let promptWasCancelled = false;',
      '    let promptWasCancelled = false;\n    let codaExecutionCompleted = false;'],
    ['      if (sessionState.titleGen) {\n        const promptText',
      '      codaExecutionCompleted = true;\n      if (sessionState.titleGen) {\n        const promptText'],
    ['        if (promptWasCancelled || activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)) {',
      '        if (promptWasCancelled || (!codaExecutionCompleted && (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)))) {'],
    ['    this.generateAndPersist(userPromptText).catch(() => {',
      '    return this.generateAndPersist(userPromptText).catch(() => {'],
    ['        sessionState.titleGen.onTurnCompleted(promptText);',
      `        await settleTitle(async () => {
          await sessionState.titleGen.onTurnCompleted(promptText);
          await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
        }, { signal: activePrompt.signal });`],
    ['    sessionState.sessionTitle = title;\n    sessionState.sessionTitleSource = "fallback";',
      '    title = Array.from(title.replace(/\\s+/g, " ").trim()).slice(0, 80).join("");\n    sessionState.sessionTitle = title;\n    sessionState.sessionTitleSource = "fallback";'],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('codex-acp title ordering patch no longer matches the locked adapter');
    source = source.replace(before, after);
  }
  return `import { settleTitle } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
