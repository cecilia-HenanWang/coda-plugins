// Coda's steering (docs/agent-protocol.md「插话」): codex-acp 1.12.0 declares `_session/steering` and, when no turn is going to
// take the message in, starts a turn of its own with it. Coda asks with `_meta.steering.idleBehavior: "promptRequired"` to be
// told so instead, and sends the message as the next prompt once the turn it meant to join has ended: then nothing is started
// and the answer is `promptRequired`. Without that behaviour codex-acp's own way is kept. Fails loudly once the adapter changes.
const patches = [
  // codex-acp reads only the session and the prompt of the request: the behaviour asked for goes along.
  [`    return {
      sessionId,
      prompt
    };
  }
  createSessionConfigOptions(sessionState) {`, `    return {
      sessionId,
      prompt,
      idleBehavior: params["_meta"]?.steering?.idleBehavior
    };
  }
  createSessionConfigOptions(sessionState) {`],
  // No live turn, or one that ended before the message was injected.
  ['    return await this.startNewTurnFromSteering(params);\n', `    if (params.idleBehavior === "promptRequired") {
      logger.log("Steering session found no running turn", { sessionId: params.sessionId });
      return { outcome: "promptRequired", reason: "noRunningTurn" };
    }
    return await this.startNewTurnFromSteering(params);\n`],
];
export function promptRequiredCodexSteering(source) {
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp steering patch no longer matches the locked adapter');
    source = source.replace(before, after);
  }
  return source;
}
