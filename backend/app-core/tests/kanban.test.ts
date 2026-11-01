import { afterEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import type {KanbanActor, KanbanBoard, KanbanCommand} from '@itookit/kanban/contracts';
import {createNestOSKanban} from '../src/kanban';
import {KanbanError} from '@itookit/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
const a: KanbanActor = { agentId: 'a', sessionId: 'sa', taskId: 'ta' };
const b: KanbanActor = { agentId: 'b', sessionId: 'sb', taskId: 'tb' };
const estimate = { complexity: 2, workUnits: 3, durationMs: 100, confidence: 'medium' as const };
async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    disposers.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs);
    let time = 1000, serial = 0;
    const logs: unknown[] = [];
    const module = (actor: KanbanActor = a) => createNestOSKanban({ store, actor, now: () => time,
        id: () => `id-${++serial}`, log: event => logs.push(event), authorize: async () => {} });
    const service = module();
    const input = { id: 'board', title: 'Board', agents: [{ agentId: 'a', responsibility: 'Investigate' }, { agentId: 'b', responsibility: 'Review' }], scope: { kind: 'project' as const, projectId: 'p' },
        policy: { claimTimeoutMs: 10, leaseMs: 200, progressTimeoutMs: 50, transferTimeoutMs: 20,
            maxComplexity: 8, maxWorkUnits: 20, maxDurationMs: 500, escalationSessionIds: ['supervisor'] } };
    let board = await service.create(input);
    const run = async (command: KanbanCommand, target = service) => {
        board = await target.execute('board', { operationId: `op-${++serial}`, expectedRevision: (await target.read('board')).revision, command }); return board;
    };
    await run({ type: 'create-item', stage: 'open', item: { id: 'i', title: 'Work', responsibility: 'Investigate', acceptance: 'Evidence', eligibleAgentIds: ['a', 'b'] } });
    return { module, service, store, logs, run, input, tick: (ms: number) => { time += ms; } };
}
it('persists project ownership and session roles across module recreation; global views share records', async () => {
    const f = await setup();
    await f.run({ type: 'register-session', itemId: 'i', sessionId: 'sb', agentId: 'b', role: 'consultant', subscribed: true });
    const boards = await f.module().related('sb'); expect(boards).toHaveLength(1);
    expect(boards[0].scope).toEqual({ kind: 'project', projectId: 'p' });
    expect(boards[0].items[0].participants.find(p => p.sessionId === 'sb')?.roles).toEqual(['consultant']);
    boards[0].title = 'mutated'; expect((await f.service.read('board')).title).toBe('Board');
    await f.service.create({ ...f.input, id: 'system', scope: { kind: 'system' } });
    expect(await f.service.list()).toHaveLength(2);
});
it('allows only one concurrent claim across independent service instances', async () => {
    const f = await setup(), revision = (await f.service.read('board')).revision;
    const results = await Promise.allSettled([f.service, f.module(b)].map((service, n) => service.execute('board', {
        operationId: `claim-${n}`, expectedRevision: revision, command: { type: 'claim', itemId: 'i', estimate } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.service.read('board')).items[0].owner).toBeDefined();
});
it('deduplicates stable operations and rejects key reuse with changed payload', async () => {
    const f = await setup(), request = { operationId: 'stable', expectedRevision: (await f.service.read('board')).revision,
        command: { type: 'claim' as const, itemId: 'i', estimate } };
    const first = await f.service.execute('board', request), second = await f.service.execute('board', request);
    expect(second.items[0].owner?.token).toBe(first.items[0].owner?.token);
    await expect(f.service.execute('board', { ...request, command: { ...request.command, estimate: { ...estimate, complexity: 3 } } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
});
it('keeps the old owner until eligible recipient accepts transfer; retains session history', async () => {
    const f = await setup(); let board = await f.run({ type: 'claim', itemId: 'i', estimate });
    const token = board.items[0].owner!.token;
    board = await f.run({ type: 'request-transfer', itemId: 'i', token, agentId: 'b' });
    expect(board.items[0].owner?.sessionId).toBe('sa');
    board = await f.run({ type: 'accept-transfer', itemId: 'i', estimate }, f.module(b));
    expect(board.items[0].owner?.sessionId).toBe('sb');
    expect(board.items[0].participants.map(p => p.sessionId)).toEqual(['sa', 'sb']);
    await expect(f.run({ type: 'renew', itemId: 'i', token })).rejects.toThrow('OWNER_MISMATCH');
});
it('escalates unclaimed work once and preserves events for durable cursor replay', async () => {
    const f = await setup(); f.tick(11); await f.service.scan(); await f.module().scan();
    const events = await f.service.events('board');
    expect(events.filter(e => e.kind === 'escalated').map(e => e.data.reason)).toEqual(['unclaimed']);
    expect(events.at(-1)?.recipients).toEqual(['supervisor']);
    expect(await f.service.events('board', events.at(-1)!.sequence)).toEqual([]);
});
it('reports expired lease and stalled work without silently reassigning', async () => {
    const f = await setup(); const board = await f.run({ type: 'claim', itemId: 'i', estimate }); f.tick(201);
    await f.service.scan();
    expect((await f.service.read('board')).items[0].owner?.token).toBe(board.items[0].owner?.token);
    expect((await f.service.events('board')).filter(e => e.kind === 'escalated').map(e => e.data.reason))
        .toEqual(expect.arrayContaining(['lease-expired', 'no-progress', 'execution-timeout']));
    await expect(f.run({ type: 'renew', itemId: 'i', token: board.items[0].owner!.token })).rejects.toThrow('LEASE_EXPIRED');
    await expect(f.run({ type: 'claim', itemId: 'i', estimate }, f.module(b))).rejects.toThrow('ALREADY_OWNED');
});
it('expires a transfer without abandoning the current owner', async () => {
    const f = await setup(); const board = await f.run({ type: 'claim', itemId: 'i', estimate });
    await f.run({ type: 'request-transfer', itemId: 'i', token: board.items[0].owner!.token, agentId: 'b' }); f.tick(21);
    await f.service.scan(); const item = (await f.service.read('board')).items[0];
    expect(item.transfer).toBeUndefined(); expect(item.owner?.agentId).toBe('a');
    expect((await f.service.events('board')).some(e => e.data.reason === 'transfer-timeout')).toBe(true);
});
it('requires independent registered reviewer and a submitted artifact', async () => {
    const f = await setup(); const board = await f.run({ type: 'claim', itemId: 'i', estimate });
    await expect(f.run({ type: 'review', itemId: 'i', accept: true }, f.module(b))).rejects.toThrow('NOT_IN_REVIEW');
    await f.run({ type: 'submit', itemId: 'i', token: board.items[0].owner!.token, resultRef: '/artifacts/result' });
    await expect(f.run({ type: 'review', itemId: 'i', accept: true }, f.module(b))).rejects.toThrow('REVIEWER_REQUIRED');
    await f.run({ type: 'register-session', itemId: 'i', sessionId: 'sb', agentId: 'b', role: 'reviewer', subscribed: true });
    expect((await f.run({ type: 'review', itemId: 'i', accept: true }, f.module(b))).items[0].status).toBe('completed');
});
it('persists messages but does not expose message content in diagnostic logs', async () => {
    const f = await setup();
    await f.run({ type: 'message', itemId: 'i', message: 'private-content', recipientSessionIds: ['sa'] });
    expect((await f.service.events('board')).at(-1)?.data.message).toBe('private-content');
    expect(JSON.stringify(f.logs)).not.toContain('private-content');
    await expect(f.run({ type: 'message', message: 'x', recipientSessionIds: ['unknown'] })).rejects.toThrow('UNKNOWN_RECIPIENT');
    expect(JSON.stringify(f.logs)).toContain('UNKNOWN_RECIPIENT');
});
it('enforces host authorization before mutation or idempotency replay', async () => {
    const f = await setup(), denied = createNestOSKanban({ store: f.store, actor: a, log: () => {},
        authorize: async () => { throw new KanbanError('FORBIDDEN'); } });
    await expect(denied.read('board')).rejects.toThrow('FORBIDDEN');
    expect(await denied.list()).toEqual([]);
    await expect(denied.execute('board', { operationId: 'forbidden', expectedRevision: 2, command: { type: 'scan' } })).rejects.toThrow('FORBIDDEN');
});
it('reports estimate thresholds and rejects invalid estimates atomically', async () => {
    const f = await setup();
    await expect(f.run({ type: 'claim', itemId: 'i', estimate: { ...estimate, durationMs: NaN } })).rejects.toThrow('INVALID_THRESHOLD');
    expect((await f.service.read('board')).items[0].owner).toBeUndefined();
    await f.run({ type: 'claim', itemId: 'i', estimate: { ...estimate, complexity: 8, workUnits: 20, durationMs: 500 } });
    expect((await f.service.events('board')).filter(e => e.kind === 'escalated').map(e => e.data.reason))
        .toEqual(['complexity-threshold', 'work-threshold', 'duration-threshold']);
});
it('retains initial and revised estimates in the append-only history', async () => {
    const f = await setup(), board = await f.run({ type: 'claim', itemId: 'i', estimate });
    await f.run({ type: 'progress', itemId: 'i', token: board.items[0].owner!.token, workUnits: 2,
        estimate: { ...estimate, durationMs: 150 } });
    const events = await f.service.events('board');
    expect(events.find(e => e.kind === 'claim')?.data.estimate?.durationMs).toBe(100);
    expect(events.find(e => e.kind === 'progress')?.data.estimate?.durationMs).toBe(150);
});
it('pages events with stable sequence and validates cursors', async () => {
    const f = await setup();
    await f.run({ type: 'message', message: 'one', recipientSessionIds: ['sa'] });
    await f.run({ type: 'message', message: 'two', recipientSessionIds: ['sa'] });
    const first = await f.service.events('board', 0, 2);
    expect(first.map(e => e.sequence)).toEqual([1, 2]);
    expect((await f.service.events('board', 2, 2)).map(e => e.sequence)).toEqual([3]);
    await expect(f.service.events('board', -1)).rejects.toThrow('INVALID_CURSOR');
});
it('coalesces monitor ticks and waits for in-flight scanning on disposal', async () => {
    const { startKanbanMonitor } = await import('@itookit/kanban/execution');
    let tick = () => {}, scans = 0, released = false, unsubscribed = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const monitor = startKanbanMonitor({ service: { scan: async () => { scans++; await gate; released = true; } } as never,
        subscribeTick: callback => { tick = callback; return () => { unsubscribed = true; }; }, onError: () => {} });
    tick(); tick(); await Promise.resolve(); expect(scans).toBe(1);
    const disposing = monitor.dispose(); expect(unsubscribed).toBe(true); expect(released).toBe(false);
    release(); await disposing; tick(); expect(scans).toBe(1);
});
it('requires eligible agents to belong to the board responsibility roster', async () => {
    const f = await setup();
    await expect(f.run({ type: 'create-item', item: { id: 'outside', title: 'Work', responsibility: 'Investigate',
        acceptance: 'Evidence', eligibleAgentIds: ['outside-agent'] } })).rejects.toThrow('AGENT_NOT_REGISTERED');
    expect((await f.service.read('board')).agents).toEqual([
        { agentId: 'a', responsibility: 'Investigate' }, { agentId: 'b', responsibility: 'Review' },
    ]);
});
