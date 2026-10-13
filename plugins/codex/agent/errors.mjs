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
