import { describe, expect, it, vi } from 'vitest';
import type { SessionHandle } from '@itookit/durable-kernel';
import type { DagEdgeDefinition, DagNodeDefinition } from '../src/contracts';
import { downstreamNodes, consumeGraphRetryIntents, type FlowGraphRetryIntent } from '../src/flow/graph-retry';

function node(id: string): DagNodeDefinition {
    return { id, name: id, plugin: 'builtin.transform', pluginVersion: '1.0.0', config: {}, inputs: {}, capabilities: [] };
}

function edge(from: string, to: string): DagEdgeDefinition {
    return { id: `${from}-${to}`, from, to, output: 'result', input: 'input' };
}

describe('downstreamNodes', () => {
    it('collects the transitive closure in topological order and excludes the source', () => {
        const nodes = [node('a'), node('b'), node('c'), node('d')];
        const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];
        expect(downstreamNodes('a', nodes, edges)).toEqual(['b', 'c']);
        expect(downstreamNodes('b', nodes, edges)).toEqual(['c']);
        expect(downstreamNodes('c', nodes, edges)).toEqual([]);
        // An unrelated node is never included.
        expect(downstreamNodes('a', nodes, edges)).not.toContain('d');
    });

    it('follows loop back edges so a retried loop node recomputes the whole cycle', () => {
        const nodes = [node('entry'), node('body'), node('router')];
        const edges = [edge('entry', 'body'), edge('body', 'router'), edge('router', 'entry')];
        expect(downstreamNodes('entry', nodes, edges)).toEqual(['body', 'router']);
    });

    it('rejects an unknown node', () => {
        expect(() => downstreamNodes('missing', [node('a')], [])).toThrow('Unknown node: missing');
    });
});

function retryIntent(requestId: string): FlowGraphRetryIntent {
    return { version: 1, requestId, sourceTaskId: 'source', retryTaskId: `retry-${requestId}`, sourceNodeId: 'a', downstream: ['b'] };
}

describe('graph retry queue reconciliation', () => {
    it('applies each intent once while preserving a concurrent append after CAS conflict', async () => {
        let queue = [retryIntent('first')];
        let version = 1;
        const getShared = vi.fn(async () => ({ value: structuredClone(queue), version }));
        const setShared = vi.fn(async (_key, value, options) => {
            if (version === 1) {
                queue.push(retryIntent('concurrent'));
                version = 2;
                throw new Error('CAS conflict');
            }
            expect(options.expectedVersion).toBe(2);
            queue = value;
            return { value, version: ++version };
        });
        const session = { getShared, setShared } as unknown as Pick<SessionHandle, 'getShared' | 'setShared'>;
        const generations = new Map<string, number>();
        const apply = vi.fn(async (intent: FlowGraphRetryIntent) => {
            generations.set(intent.requestId, (generations.get(intent.requestId) ?? 0) + 1);
        });
        expect(await consumeGraphRetryIntents(session, 'root', apply)).toBe(2);
        expect([...generations.values()]).toEqual([1, 1]);
        expect(queue.map(intent => [intent.requestId, intent.applied])).toEqual([['first', true], ['concurrent', true]]);
    });

    it('bounds failed acknowledgement retries without repeating graph mutations', async () => {
        const failure = new Error('storage unavailable');
        const session = {
            getShared: vi.fn(async () => ({ value: [retryIntent('first')], version: 1 })),
            setShared: vi.fn(async () => { throw failure; }),
        } as unknown as Pick<SessionHandle, 'getShared' | 'setShared'>;
        const apply = vi.fn(async () => undefined);
        await expect(consumeGraphRetryIntents(session, 'root', apply)).rejects.toBe(failure);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(session.setShared).toHaveBeenCalledTimes(5);
    });

    it('does not acknowledge an intent whose graph reconciliation failed', async () => {
        const session = {
            getShared: vi.fn(async () => ({ value: [retryIntent('first')], version: 1 })),
            setShared: vi.fn(),
        } as unknown as Pick<SessionHandle, 'getShared' | 'setShared'>;
        await expect(consumeGraphRetryIntents(session, 'root', async () => { throw new Error('attach failed'); }))
            .rejects.toThrow('attach failed');
        expect(session.setShared).not.toHaveBeenCalled();
    });
});

it('commits scheduler state before acknowledgement and leaves failed commits pending', async () => {
    const calls: string[] = [];
    const session = {
        getShared: vi.fn(async () => ({ value: [retryIntent('first')], version: 1 })),
        setShared: vi.fn(async () => { calls.push('ack'); }),
    } as unknown as Pick<SessionHandle, 'getShared' | 'setShared'>;
    await consumeGraphRetryIntents(session, 'root', async () => { calls.push('apply'); }, async () => { calls.push('checkpoint'); });
    expect(calls).toEqual(['apply', 'checkpoint', 'ack']);
    session.setShared = vi.fn();
    await expect(consumeGraphRetryIntents(session, 'root', async () => {}, async () => { throw new Error('checkpoint failed'); }))
        .rejects.toThrow('checkpoint failed');
    expect(session.setShared).not.toHaveBeenCalled();
});

it('rejects a corrupt queue without mutating or acknowledging it', async () => {
    const session = { getShared: vi.fn(async () => ({ value: [retryIntent('valid'), null], version: 1 })), setShared: vi.fn() };
    const apply = vi.fn();
    await expect(consumeGraphRetryIntents(session as never, 'root', apply)).rejects.toThrow('Invalid Flow graph retry queue');
    expect(apply).not.toHaveBeenCalled(); expect(session.setShared).not.toHaveBeenCalled();
});
