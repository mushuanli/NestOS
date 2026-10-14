import { expect, it } from 'vitest';
import { buildLlmTaskInput } from '../src/durable/task-spec';

it('copies memory authority independently from mutable host configuration', () => {
    const policy = { namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'], retention: { maxEntriesPerScope: 10 } };
    const input = buildLlmTaskInput({ sessionId: 'session', roundId: 'round', messages: [], memoryPolicy: policy });
    policy.writeScopes.push('private'); policy.retention.maxEntriesPerScope = 1;
    expect(input.memoryPolicy).toEqual({ namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'], retention: { maxEntriesPerScope: 10 } });
    input.memoryPolicy!.readScopes.push('other');
    expect(policy.readScopes).toEqual(['project']);
});

it('does not invent memory authority for callers without a policy', () => {
    expect(buildLlmTaskInput({ sessionId: 'session', roundId: 'round', messages: [] })).not.toHaveProperty('memoryPolicy');
});

it.each([null, {}, { namespaceId: 'n', readScopes: ['r'], writeScopes: 'all' },
    { namespaceId: 'n', readScopes: [], writeScopes: [], retrievalLimit: -1 }])('rejects malformed authority before task submission: %j', memoryPolicy => {
    expect(() => buildLlmTaskInput({ sessionId: 's', roundId: 'r', messages: [], memoryPolicy: memoryPolicy as never })).toThrow('Invalid task memory policy');
});
