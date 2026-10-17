// Claude SDK 0.3.296's synthetic API-error messages. `rate_limit` also covers temporary throttling and `billing_error`
// alone does not establish an exhausted balance. Match explicit provider reasons, only at an error boundary; never
// classify ordinary assistant text or infer exhaustion from an HTTP status or the quota panel's cached utilization.
export function claudeQuotaFailure(reason, type) {
  if (type !== undefined && !['rate_limit', 'billing_error'].includes(type)) return undefined;
  if (typeof reason !== 'string') return undefined;
  const quota = /^You've hit your (?:(?:session|weekly|Opus|Sonnet|Fable|usage credit|monthly spend|channel's monthly spend) limit|team's shared budget)(?:$|[ ·]|\.(?:\s|$))/;
  const credits = /^(?:You're out of usage credits|Credit balance is too low|You've reached your Fable limit)(?:$|[ ·]|\.(?:\s|$))/;
  return quota.test(reason) || credits.test(reason) ? { kind: 'quota_exhausted' } : undefined;
}
