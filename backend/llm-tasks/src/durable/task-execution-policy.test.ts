import { expect, it } from 'vitest';
import { buildLlmTaskInput } from './task-spec';

it('copies opaque connection snapshots before task submission', () => {
    const connectionSnapshot = { providerId: 'p', modelId: 'original', requirements: { features: ['tools'] } };
    const input = buildLlmTaskInput({ sessionId: 's', roundId: 'r', messages: [], connectionSnapshot });
    connectionSnapshot.modelId = 'changed'; connectionSnapshot.requirements.features.push('thinking');
    expect(input.connectionSnapshot).toEqual({ providerId: 'p', modelId: 'original', requirements: { features: ['tools'] } });
});

it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid tool timeout %s before submission', toolTimeoutMs => {
    expect(() => buildLlmTaskInput({ sessionId: 's', roundId: 'r', messages: [], toolTimeoutMs })).toThrow('positive safe integer');
});

it.each([null, 'invalid', [], { retries: Infinity }, { retries: Number.MAX_SAFE_INTEGER }])('rejects malformed persisted retry policy %j', llmRetry => {
    expect(() => buildLlmTaskInput({ sessionId: 's', roundId: 'r', messages: [], llmRetry: llmRetry as never })).toThrow('Invalid llmRetry');
});
