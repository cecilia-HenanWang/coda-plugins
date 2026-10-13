// codex-acp 1.12.0 outlives its Codex app-server. When that child exits on its own, the adapter only
// fails background tasks: a started turn keeps waiting for a completion that never comes, and every
// later request fails against the dead child. Follow the child out instead, so the session host reports
// an agent exit and the backend settles the turn through its connection-lost path. A deliberate provider
// restart moves the generation first, and stays unaffected. Fails loudly once the adapter changes.
const before = `      if (generation !== this.codexProcessGeneration) return;
      void this.finishAllAsyncTasks("failed", "after the Codex process exited");`;
// Exit only after stdout has flushed the failed background tasks.
const after = `      if (generation !== this.codexProcessGeneration) return;
      void this.finishAllAsyncTasks("failed", "after the Codex process exited").finally(() => {
        logger.log("Codex process exited; ending the adapter with it");
        process.stdout.write("", () => process.exit(1));
      });`;
export function followCodexProcessExit(source) {
  if (source.split(before).length !== 2) throw new Error('codex-acp process exit patch no longer matches the locked adapter');
  return source.replace(before, after);
}
