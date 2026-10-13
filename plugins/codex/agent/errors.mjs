// codex-acp puts model-service errors in data.message, SDK-wrapped exceptions in data.details, and some configuration
// errors in a string data payload. Explain them in ACP's standard message so clients need not know those private shapes.
export function explainCodexError(message) {
  if (!message || typeof message !== 'object' || !('id' in message) || 'method' in message) return message;
  const error = message.error;
  if (!error || typeof error.message !== 'string') return message;
  const parts = [error.message];
  for (const value of [error.data?.message, error.data?.details, error.data]) {
    const detail = typeof value === 'string' ? value.trim() : '';
    if (detail && !parts.some(part => part.includes(detail))) parts.push(detail);
  }
  return parts.length === 1 ? message : { ...message, error: { ...error, message: parts.join('\n\n') } };
}

// Native service facts, not a retry policy: Coda decides when/how often to try again. Explicit permanent kinds win over
// generic messages (in particular, quota failures also arrive as JSON-RPC Internal error).
export function codexFailureData(error, input) {
  const data = error.data && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : {};
  const info = data.codexErrorInfo;
  const message = typeof data.message === 'string' ? data.message : typeof data.details === 'string' ? data.details : typeof error.data === 'string' ? error.data : error.message;
  let provider; try { provider = JSON.parse(message); } catch {}
  const status = provider?.status ?? (info && typeof info === 'object' ? Object.values(info)[0]?.httpStatusCode : null);
  const permanent = ['usageLimitExceeded', 'unauthorized', 'contextWindowExceeded', 'sessionBudgetExceeded',
    'cyberPolicy', 'misalignmentPolicyViolation', 'sandboxError', 'threadRollbackFailed'].includes(info) || [401, 403].includes(status);
  const unavailableModel = provider?.type === 'error' && status === 400 && provider.error?.type === 'invalid_request_error' &&
    /^model ['"][^'"\r\n]+['"] is not enabled in rustponsesapi\.?$/.test(provider.error.message ?? '');
  const transport = info && typeof info === 'object' && ['httpConnectionFailed', 'responseStreamConnectionFailed',
    'responseStreamDisconnected', 'responseTooManyFailedAttempts'].some(kind => kind in info);
  const temporary = !permanent && (unavailableModel || (status >= 500 && status <= 599) ||
    ['internalServerError', 'serverOverloaded'].includes(info) ||
    (transport && (status == null || status >= 500)) ||
    (info === 'other' && message === 'Selected model is at capacity. Please try a different model.') ||
    (info == null && error.code === -32603 && message?.trim() === 'Internal error'));
  if (!temporary) return data;
  return { ...data, ...(data.message || data.details ? {} : { details: error.message }),
    _meta: { ...data._meta, coda: { ...data._meta?.coda, failure: { kind: 'service_unavailable', input: data._meta?.coda?.failure?.input === 'accepted' ? 'accepted' : input } } } };
}

// codex-acp 1.12 only throws quota/auth failures for plain ACP clients; other failed native turns look successful.
// Keep native failure data at the ACP boundary, even when the terminal notification has no preceding error event.
export function reportedCodexFailures(source) {
  const replacements = [
    ['  async handleFailedTurn(turn) {\n    const activeFailure', `  async handleFailedTurn(turn) {
    if (!this.supportsTypedSessionFailures && turn.status === "failed" && this.failure === null) {
      this.failure = RequestError.internalError(this.createTurnErrorData(turn.error ?? {
        message: "Turn failed", codexErrorInfo: null, additionalDetails: null
      }));
      return;
    }
    const activeFailure`],
    ['    if (error51 === "usageLimitExceeded") {\n      this.failure = RequestError.internalError(',
      '    if (!this.isAuthenticationRequiredError(error51)) {\n      this.failure = RequestError.internalError('],
    ['    return createAgentTextMessageChunk(`${params.error.message}\n\n`);', '    return null;'],
    ['    return data;\n  }\n  handleTokenUsageUpdated(params) {',
      '    return codexFailureData({ code: -32603, message: error51.message, data }, "accepted");\n  }\n  handleTokenUsageUpdated(params) {'],
    ['      throw err;\n    } finally {\n      promptNotificationsActive = false;', `      const codaData = codexFailureData(err, sessionState.currentTurnId === null ? "not_accepted" : "accepted");
      if (codaData._meta?.coda?.failure) throw new RequestError(err.code ?? -32603, err.message, codaData);
      throw err;
    } finally {
      promptNotificationsActive = false;`],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('codex-acp error reporting patch no longer matches the locked adapter');
    source = source.replace(before, after);
  }
  return `import { codexFailureData } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
