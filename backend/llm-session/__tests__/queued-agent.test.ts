import {expect, it} from 'vitest';
import {freezeQueuedAgent, isQueuedAgent, readQueuedAgent} from '../src/session/queued-agent';
import {InstructionQueueStore, instructionQueueProjection} from '../src/persistence/instruction-queue-store';
import type {SessionInstructionQueue} from '../src/contracts/instruction-queue';

const identity = () => ({id: 'agent', name: 'Agent', type: 'agent' as const, agentVersion: 'v1', exposure: 'global' as const,
    systemPrompt: ['Frozen rules'], capabilityPolicy: {toolIds: [], mcpProfileIds: []}});

it('keeps an immutable ordinary Agent identity without credentials or live configuration references', () => {
    const source = identity(), saved = freezeQueuedAgent({...source, apiKey: 'PRIVATE-KEY'} as never);
    source.systemPrompt[0] = 'Changed';
    expect(readQueuedAgent(saved, 'agent')).toMatchObject({systemPrompt: ['Frozen rules'], agentVersion: 'v1'});
    expect(JSON.stringify(saved)).not.toContain('PRIVATE-KEY');
    const first = readQueuedAgent(saved, 'agent')!; first.systemPrompt!.push('Local mutation');
    expect(readQueuedAgent(saved, 'agent')!.systemPrompt).toEqual(['Frozen rules']);
    expect(readQueuedAgent(undefined, 'legacy')).toBeUndefined();
    expect(() => freezeQueuedAgent({...source, exposure: 'local'})).toThrow('Invalid admitted Agent identity');
});

it('rejects corrupt, foreign, unknown-version and credential-bearing identities in persistent queues', async () => {
    const agent = freezeQueuedAgent(identity()), queue: SessionInstructionQueue & {schemaVersion: 1} = {schemaVersion: 1, sessionId: 's', revision: 1, paused: true,
        items: [{id: 'request', text: 'Request', files: [], agentId: 'agent', branch: 'main', state: 'pending', createdAt: 1,
            connectionBinding: {defaults: {}, agent}}]};
    let saved = structuredClone(queue);
    const store = new InstructionQueueStore({inspectSession: async () => ({getShared: async () => ({value: saved, version: 1})})} as never);
    expect((await store.read('s')).items[0].connectionBinding?.agent?.digest).toBe(agent.digest);
    for (const corrupt of [
        (value: typeof agent) => {value.config.id = 'foreign';},
        (value: typeof agent) => {value.config.systemPrompt = ['Changed'];},
        (value: typeof agent) => {value.version = 2 as never;},
        (value: typeof agent) => {(value.config.capabilityPolicy as unknown as Record<string, unknown>).apiKey = 'PRIVATE';},
    ]) {
        saved = structuredClone(queue); corrupt(saved.items[0].connectionBinding!.agent!);
        expect(isQueuedAgent(saved.items[0].connectionBinding!.agent, 'agent')).toBe(false);
        await expect(store.read('s')).rejects.toMatchObject({code: 'QUEUE_STORAGE_INVALID'});
    }
    expect(instructionQueueProjection(queue).items[0].connectionBinding).not.toHaveProperty('agent');
    expect(queue.items[0].connectionBinding?.agent).toEqual(agent);
    saved = structuredClone(queue); saved.items[0].connectionBinding!.identityVersion = 2 as never;
    await expect(store.read('s')).rejects.toMatchObject({code: 'QUEUE_STORAGE_INVALID'});
});
