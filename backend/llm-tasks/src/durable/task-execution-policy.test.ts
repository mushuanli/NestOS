import { expect, it } from 'vitest';
import { buildLlmTaskInput } from './task-spec';

it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid tool timeout %s before submission', toolTimeoutMs => {
    expect(() => buildLlmTaskInput({ sessionId: 's', roundId: 'r', messages: [], toolTimeoutMs })).toThrow('positive safe integer');
});

it.each([null, 'invalid', [], { retries: Infinity }, { retries: Number.MAX_SAFE_INTEGER }])('rejects malformed persisted retry policy %j', llmRetry => {
    expect(() => buildLlmTaskInput({ sessionId: 's', roundId: 'r', messages: [], llmRetry: llmRetry as never })).toThrow('Invalid llmRetry');
});
