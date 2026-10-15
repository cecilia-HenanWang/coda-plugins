const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Kimi 2.1.1 maps this quota response to ACP auth_required. Keep the provider's reason, but report an execution failure
// so clients do not send the user to sign in again. A 403 or provider.auth_error alone does not establish quota exhaustion.
export function classifyKimiError(message) {
  const error = message.error;
  if (error?.code !== -32000 || typeof error.message !== 'string') return message;
  const reason = error.message.replace(/^Authentication required:\s*/, '');
  if (!/^403 You've reached your 5-hour usage limit\.(?:\s|$)/.test(reason)) return message;
  const data = record(error.data) ? error.data : error.data == null ? {} : { details: error.data };
  const meta = record(data._meta) ? data._meta : {};
  const coda = record(meta.coda) ? meta.coda : {};
  return { ...message, error: { ...error, code: -32603,
    message: reason,
    data: { ...data, _meta: { ...meta, coda: { ...coda, failure: { kind: 'quota_exhausted' } } } } } };
}
