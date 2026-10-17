import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeQuotaFailure } from '../../../plugins/claude/agent/errors.mjs';

test('explicit Claude subscription windows and exhausted credits are quota failures', () => {
  for (const reason of [
    "You've hit your weekly limit · resets 10pm (Asia/Singapore)",
    "You've hit your session limit · resets 10pm (Asia/Singapore)",
    "You've hit your Opus limit", "You've hit your Sonnet limit", "You've hit your Fable limit",
    "You've hit your usage credit limit", "You've hit your monthly spend limit.",
    "You've hit your channel's monthly spend limit.", "You've hit your team's shared budget. Switch to another model.",
    "You've reached your Fable limit.", "You're out of usage credits. Switch to another model.",
    'Credit balance is too low',
  ]) {
    assert.deepEqual(claudeQuotaFailure(reason, 'rate_limit'), { kind: 'quota_exhausted' }, reason);
    assert.deepEqual(claudeQuotaFailure(reason), { kind: 'quota_exhausted' }, 'terminal error without an assistant frame');
  }
  assert.deepEqual(claudeQuotaFailure('Credit balance is too low', 'billing_error'), { kind: 'quota_exhausted' });
});

test('temporary throttling, authentication, billing configuration and quoted prose do not establish quota exhaustion', () => {
  for (const [reason, type] of [
    ['429 Too many requests', 'rate_limit'], ['Rate limit reached', 'rate_limit'],
    ['403 Forbidden', 'rate_limit'], ['Payment method declined', 'billing_error'],
    ["You've hit your weekly limit · resets 10pm", 'authentication_failed'],
    ["You've hit your weekly limit · resets 10pm", 'invalid_request'],
    ["Example: You've hit your weekly limit", 'rate_limit'],
    ["You've hit your weekly limit.example", 'rate_limit'],
    ["You've hit your fast limit", 'rate_limit'],
    ['Your credit balance is unknown', 'billing_error'], [undefined, 'rate_limit'],
  ]) assert.equal(claudeQuotaFailure(reason, type), undefined, reason);
});
