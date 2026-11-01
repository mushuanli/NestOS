import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanDiscoveryChange, KanbanScanInput, KanbanScanSession} from '@itookit/kanban/contracts';
import {DEFAULT_KANBAN_SCAN_POLICY} from '@itookit/kanban/contracts';
import {createKanbanDiscovery} from '@itookit/kanban/discovery';
import {createNestOSKanban, createKanbanDiscoveryFlow, createHarnessKanbanSource} from '../src/kanban';
import {SeqKanbanStore, ConditionalKanbanStore} from '@itookit/kanban/storage';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {for (const dispose of disposers.splice(0)) await dispose();});
async function fixture(autoCreate = false) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); disposers.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'), '/project/.nestos/kanban');
    let now = 1000, serial = 0;
    const actor = {agentId: 'planner', sessionId: 'scan-session', taskId: 'scan-task'}, log = vi.fn();
    const service = createNestOSKanban({store, actor, log, now: () => now, id: () => `token-${++serial}`, authorize: async () => {}});
    await service.create({id: 'b', title: 'Board', scope: {kind: 'project', projectId: 'p'}, agents: [{agentId: 'worker', responsibility: 'Implement'}],
        policy: {claimTimeoutMs: 100, leaseMs: 10000, progressTimeoutMs: 1000, transferTimeoutMs: 100,
            maxComplexity: 10, maxWorkUnits: 20, maxDurationMs: 10000, escalationSessionIds: ['supervisor']}});
    const sourceSession: KanbanScanSession = {id: 's', revision: 'r1', activity: 'idle', updatedAt: 900, idleSince: 900, archived: false};
    const source = {projectId: 'p', kind: 'local' as const, list: vi.fn(async () => [{...sourceSession}]),
        inspect: vi.fn(async () => ({...sourceSession})), read: vi.fn(async () => ({session: {...sourceSession}, complete: true,
            messages: [{id: 'm', role: 'user' as const, text: 'Implement PDF export'}]}))};
    const executor = {identity: 'flow@v1', run: vi.fn(async (input: KanbanScanInput): Promise<KanbanDiscoveryChange[]> => [{action: 'create', itemId: 'export', title: 'Export PDF',
        responsibility: 'Implement export', acceptance: 'PDF output', eligibleAgentIds: ['worker'],
        sources: [{sessionId: 's', messageId: 'm', revision: input.sessions[0].session.revision, role: 'user'}]}])};
    const options = {boardId: 'b', store, service, source, executor, authorize: vi.fn(async () => {}), log,
        now: () => now, id: () => `scan-${++serial}`, policy: {...DEFAULT_KANBAN_SCAN_POLICY, idleMs: 100, autoCreate,
            connection: {kind: 'local' as const, connectionId: 'analysis', allowContentTransfer: false}}};
    const scanner = createKanbanDiscovery(options);
    return {store, service, sourceSession, source, executor, scanner, options, tick: (ms: number) => {now += ms;}};
}
it('waits for sustained idle, adds a source-linked proposal and commits its watermark atomically', async () => {
    const f = await fixture(); await f.scanner.scan(); expect(f.executor.run).not.toHaveBeenCalled();
    f.tick(101); await f.scanner.scan();
    const board = await f.service.read('b'); expect(board.items[0]).toMatchObject({id: 'export', status: 'proposed', sources: [{sessionId: 's', messageId: 'm', revision: 'r1'}]});
    expect(await f.service.related('s')).toHaveLength(1);
    expect((await f.store.read('b'))?.discovery?.checkpoints).toEqual({s: 'r1'});
    await f.scanner.scan(); expect(f.executor.run).toHaveBeenCalledOnce();
});
it('supports explicit automatic admission while default proposals remain unclaimable', async () => {
    const f = await fixture(true); await f.scanner.scan(); f.tick(101); await f.scanner.scan();
    expect((await f.service.read('b')).items[0].status).toBe('open');
});
it('does not scan active, waiting, unknown or scanner-owned sessions', async () => {
    const f = await fixture();
    for (const activity of ['active', 'waiting', 'unknown'] as const) {f.sourceSession.activity = activity; await f.scanner.scan(); f.tick(500);}
    f.sourceSession.activity = 'idle'; f.sourceSession.scannerOwned = true;
    await f.scanner.scan(); f.tick(500); await f.scanner.scan(); expect(f.executor.run).not.toHaveBeenCalled();
});
it('resets the idle window after content changes and after activity resumes', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101); f.sourceSession.revision = 'r2';
    await f.scanner.scan(); expect(f.executor.run).not.toHaveBeenCalled();
    f.sourceSession.activity = 'active'; await f.scanner.scan(); f.tick(101); f.sourceSession.activity = 'idle';
    await f.scanner.scan(); expect(f.executor.run).not.toHaveBeenCalled(); f.tick(101); await f.scanner.scan();
    expect(f.executor.run).toHaveBeenCalledOnce();
});
it('rechecks sources after analysis and never commits results from a changed conversation', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    const original = f.executor.run.getMockImplementation()!;
    f.executor.run.mockImplementationOnce(async input => {const changes = await original(input); f.sourceSession.activity = 'active'; return changes;});
    await expect(f.scanner.scan()).rejects.toThrow('SOURCE_CHANGED');
    expect((await f.service.read('b')).items).toEqual([]);
    expect((await f.store.read('b'))?.discovery?.checkpoints).toEqual({});
    expect((await f.store.read('b'))?.discovery?.pending).toBeUndefined();
});
it('can backfill archived sessions once and honor archive exclusion', async () => {
    const f = await fixture(); f.sourceSession.archived = true; await f.scanner.scan(); f.tick(101); await f.scanner.scan();
    expect(f.executor.run).toHaveBeenCalledOnce(); await f.scanner.scan(); expect(f.executor.run).toHaveBeenCalledOnce();
    const g = await fixture(); g.sourceSession.archived = true; g.options.policy.includeArchived = false;
    await g.scanner.scan(); g.tick(101); await g.scanner.scan(); expect(g.executor.run).not.toHaveBeenCalled();
});
it('defers unclassified history and rejects invented citations without marking it processed', async () => {
    const f = await fixture(); f.source.read.mockImplementationOnce(async () => ({session: {...f.sourceSession}, complete: false, messages: []}));
    await f.scanner.scan(); f.tick(101); await f.scanner.scan(); expect(f.executor.run).not.toHaveBeenCalled();
    f.executor.run.mockImplementationOnce(async () => [{action: 'create', itemId: 'fake', title: 'Fake', responsibility: 'x', acceptance: 'x', eligibleAgentIds: ['worker'],
        sources: [{sessionId: 's', messageId: 'invented', revision: 'r1', role: 'user'}]}]);
    await expect(f.scanner.scan()).rejects.toThrow('INVALID_SOURCE_REFERENCE');
    expect((await f.service.read('b')).items).toEqual([]); expect((await f.store.read('b'))?.discovery?.checkpoints).toEqual({});
});
it('does not silently send remote content to a local connection', async () => {
    const f = await fixture(); Object.assign(f.source, {kind: 'remote'});
    await expect(f.scanner.scan()).rejects.toThrow('CONTENT_TRANSFER_NOT_ALLOWED');
    expect(f.source.list).not.toHaveBeenCalled();
});
it('coalesces concurrent triggers and keeps project leases across scanner instances', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
    const original = f.executor.run.getMockImplementation()!;
    f.executor.run.mockImplementationOnce(async input => {await gate; return original(input);});
    const work = f.scanner.scan(); await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce());
    await createKanbanDiscovery(f.options).scan(); const same = f.scanner.scan(); release(); await Promise.all([work, same]);
    expect(f.executor.run).toHaveBeenCalledOnce();
});
it('publishes a Flow resource with an explicit analysis slot and no execution tools', () => {
    const flow = createKanbanDiscoveryFlow(); expect(flow.connections).toEqual([{name: 'analysis', required: true}]);
    expect(flow.nodes[0].config?.toolIds).toEqual([]); expect(flow.outputs).toHaveProperty('changes');
});
it('refuses remote history fallback and preserves canonical source identities', async () => {
    const source = createHarnessKanbanSource({projectId: 'p', profileId: 'native', client: {inspect: async () => ({session: {
        id: 's', title: '', cwd: null, status: 'idle', updatedAt: 1000, resumable: true, lastTurnResult: 'completed'}})} as never,
        identity: id => `node:p:${id}`, nativeId: id => id.split(':').at(-1)!, scannerOwned: () => false});
    await expect(source.inspect('node:p:s')).rejects.toThrow('SESSION_DIGEST_REQUIRED');
});
it('remote project storage uses one conditional SeqFile transaction and never retries unknown writes', async () => {
    const entries = new Map<string, unknown>(), transaction = vi.fn(async () => {throw new Error('unknown');});
    const store = new ConditionalKanbanStore({query: async (_path: string, selection: {keys: string[]}) => ({next: null, revision: 'old', entries: [...entries].filter(([key]) => selection.keys.includes(key)).map(([key, value]) => ({key, value}))}), transaction} as never, async () => {});
    await expect(store.update('b', 'op', 'fingerprint', () => ({schema: 1, board: {id: 'b', items: []} as never, sequence: 0, events: [], escalations: []}))).rejects.toThrow('unknown');
    expect(transaction).toHaveBeenCalledOnce(); expect(transaction.mock.calls[0][0]).toBe('kanban/boards.seq');
});
it('compiles the discovery Flow through the production compiler with a frozen analysis binding', async () => {
    const {createFlowRevision, flowToDag} = await import('@itookit/llm-flow');
    const draft = createKanbanDiscoveryFlow();
    const graph = await flowToDag(createFlowRevision(draft, 1), undefined, 'analysis-connection', undefined, [], undefined,
        false, 'analysis-connection', {analysis: 'analysis-connection'}, async revision => ({...revision, connections: revision.connections?.map(slot => ({...slot, connectionId: 'analysis-connection'}))}), {snapshot: '{"sessions":[]}'});
    expect(graph.nodes.some(node => node.plugin === 'builtin.agent')).toBe(true);
    expect(graph.nodes.some(node => node.plugin === 'builtin.return')).toBe(true);
});
it('reuses the same frozen Flow run after lost execution responses and lease recovery', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    f.executor.run.mockRejectedValueOnce(new Error('response lost'));
    await expect(f.scanner.scan()).rejects.toThrow('response lost');
    const originalRun = f.executor.run.mock.calls[0][0].runId;
    f.tick(f.options.policy.leaseMs + 1);
    await createKanbanDiscovery(f.options).scan();
    expect(f.executor.run.mock.calls[1][0].runId).toBe(originalRun);
    expect((await f.service.read('b')).items).toHaveLength(1);
});
it('keeps the watermark unchanged if any board mutation in the batch is invalid', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    const original = f.executor.run.getMockImplementation()!;
    f.executor.run.mockImplementationOnce(async input => {
        const changes = await original(input); return [...changes, {...changes[0], itemId: 'bad', eligibleAgentIds: ['not-registered']}];
    });
    await expect(f.scanner.scan()).rejects.toThrow('AGENT_NOT_REGISTERED');
    expect((await f.service.read('b')).items).toEqual([]);
    expect((await f.store.read('b'))?.discovery?.checkpoints).toEqual({});
});
it('runs a published Flow with an explicit local connection and reads only its declared return', async () => {
    const {createPublishedKanbanExecutor} = await import('../src/kanban');
    const prepared = {plan: {task: {program: {kind: 'flow.aggregate'}, input: {initialScheduler: {spec: {nodes: [
        {plugin: 'builtin.agent', config: {toolIds: [], connectionId: 'chosen'}}, {plugin: 'builtin.return', config: {}},
    ]}}}}}};
    const calls = {prepareTaskCall: vi.fn(async () => prepared), submitPreparedTaskCall: vi.fn(async () => ({submission: {task: {taskId: 'caller'}}}))};
    const kernel = {attachTask: vi.fn(async () => ({wait: async () => ({status: 'succeeded', output: {exit: {status: 'succeeded', output: {
        nodes: {__flow_return: {outputs: {changes: {outputName: 'changes', type: 'json', content: '{"changes":[]}'}}}},
    }}}})}))};
    const executor = createPublishedKanbanExecutor({calls: calls as never, kernel: kernel as never,
        target: {kind: 'flow', id: 'scan', version: '1', digest: 'fixed'} as never, prepareSession: async () => 'scan-session'});
    const input = {runId: 'stable', connection: {kind: 'local', connectionId: 'chosen', allowContentTransfer: false}} as KanbanScanInput;
    expect(await executor.run(input)).toEqual([]);
    expect(calls.submitPreparedTaskCall.mock.calls[0][0].request.overrides).toMatchObject({connectionId: 'chosen', flowConnectionBindings: {analysis: 'chosen'}});
    input.connection.kind = 'remote';
    await expect(executor.run(input)).rejects.toThrow('SCANNER_CONNECTION_MISMATCH');
    expect(calls.submitPreparedTaskCall).toHaveBeenCalledOnce();
    Object.assign(prepared.plan.task.input.initialScheduler.spec.nodes[0].config, {execution: {kind: 'harness', connectionId: 'chosen'}});
    expect(await executor.run(input)).toEqual([]);
    expect(calls.submitPreparedTaskCall.mock.calls[1][0].request.overrides).toBeUndefined();
});
it('projects only explicit local user and assistant text from settled user rounds', async () => {
    const {createLocalKanbanSource} = await import('../src/kanban');
    const info: KanbanScanSession = {id: 's', revision: '1', updatedAt: 1000, idleSince: 1000, activity: 'idle', archived: true};
    const source = createLocalKanbanSource({projectId: 'p', list: async () => [info], inspect: async () => info,
        repository: {readHistoryChain: async () => ({rounds: [{id: 'r', origin: 'user', status: 'completed',
            input: [{role: 'system', content: 'rules'}, {role: 'user', content: 'Export PDF'}],
            output: [{role: 'tool', content: 'hidden result'}, {role: 'assistant', content: [{type: 'thinking', thinking: 'hidden'}, {type: 'text', text: 'Summary'}]}]},
            {id: 'internal', origin: 'user', exposure: 'internal', status: 'completed', input: [{role: 'user', content: 'scanner input'}], output: []}], chain: [], branch: 'main'})} as never});
    const text = await source.read(info, 10000);
    expect(text.messages.map(m => m.text)).toEqual(['Export PDF', 'Summary']); expect(text.complete).toBe(true);
});
it('backfills unloaded archived native history only with explicit inactive evidence', async () => {
    const native = {id: 's', title: 'Archived', cwd: '/p', status: 'notLoaded', updatedAt: 1000, archived: true, resumable: true, writerLock: {status: 'not-held', checkedAt: 1000}};
    const digest = vi.fn(async () => ({session: native, messages: [], revision: 'a'.repeat(64), nextCursor: null, omittedUnclassified: 0}));
    const source = createHarnessKanbanSource({projectId: 'p', profileId: 'native', client: {digest,
        list: async (_profile: string, query: {archived: boolean}) => ({sessions: query.archived ? [native] : [], nextCursor: null})} as never,
        identity: id => `node:p:${id}`, nativeId: id => id.split(':').at(-1)!, scannerOwned: () => false});
    expect((await source.list(true))[0]).toMatchObject({id: 'node:p:s', activity: 'idle', archived: true});
    expect(digest).toHaveBeenCalledWith('native', 's', {metadataOnly: true});
});
it('fences an old scanner after another instance takes over an expired lease', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
    const original = f.executor.run.getMockImplementation()!;
    f.executor.run.mockImplementationOnce(async input => {await gate; return original(input);});
    const first = f.scanner.scan().catch(error => error);
    await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce()); f.tick(f.options.policy.leaseMs + 1);
    await createKanbanDiscovery(f.options).scan(); release();
    expect((await first).code).toBe('SCAN_LEASE_EXPIRED');
    expect((await f.service.read('b')).items).toHaveLength(1);
});
it('links new source revisions to existing work instead of creating another item', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101); await f.scanner.scan();
    f.sourceSession.revision = 'r2'; await f.scanner.scan(); f.tick(101);
    const original = f.executor.run.getMockImplementation()!;
    f.executor.run.mockImplementationOnce(async input => (await original(input)).map(change => ({...change, action: 'link'})));
    await f.scanner.scan();
    const board = await f.service.read('b'); expect(board.items).toHaveLength(1);
    expect(board.items[0].sources?.map(s => s.revision)).toEqual(['r1', 'r2']);
    expect((await f.store.read('b'))?.discovery?.checkpoints.s).toBe('r2');
});
it('does not discard unknown execution and start a new scan when its source changes', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    f.executor.run.mockRejectedValueOnce(new Error('unknown execution'));
    await expect(f.scanner.scan()).rejects.toThrow('unknown execution');
    const runId = (await f.store.read('b'))?.discovery?.pending?.runId;
    f.sourceSession.revision = 'r2';
    await expect(f.scanner.scan()).rejects.toThrow('SCAN_EXECUTION_UNSETTLED');
    expect((await f.store.read('b'))?.discovery?.pending?.runId).toBe(runId);
    expect(f.executor.run).toHaveBeenCalledOnce();
});
it('allows an authorized reset after invalid output has settled, without advancing the checkpoint', async () => {
    const f = await fixture(); await f.scanner.scan(); f.tick(101);
    f.executor.run.mockResolvedValueOnce([{action: 'create', itemId: 'bad', title: '', responsibility: '', acceptance: '', eligibleAgentIds: [], sources: []}]);
    await expect(f.scanner.scan()).rejects.toThrow();
    const run = (await f.store.read('b'))!.discovery!.pending!;
    expect(run.executionSettled).toBe(true); await f.scanner.reset(run.runId);
    expect((await f.store.read('b'))!.discovery!.checkpoints).toEqual({});
    await f.scanner.scan(); expect((await f.service.read('b')).items).toHaveLength(1);
});
it('builds a remote analysis Flow around a bound Agent without requiring a local LLM slot', () => {
    const flow = createKanbanDiscoveryFlow('remote-analyst', 'remote');
    expect(flow.connections).toBeUndefined(); expect(flow.defaultConnection).toBeUndefined();
    expect(flow.nodes[0].config).toMatchObject({agentId: 'remote-analyst'});
    expect(() => createKanbanDiscoveryFlow(undefined, 'remote')).toThrow('REMOTE_SCANNER_AGENT_REQUIRED');
});
it('bounds model context on large project backlogs and requires review when coverage is partial', async () => {
    const f = await fixture(true);
    for (let index = 0; index < 80; index++) {
        await f.service.execute('b', {operationId: `seed-${index}`, expectedRevision: (await f.service.read('b')).revision,
            command: {type: 'create-item', item: {id: `future-${index}`, title: `Future feature ${index}`,
                responsibility: 'detail '.repeat(300), acceptance: 'Verify delivery', eligibleAgentIds: ['worker']}}});
    }
    await f.scanner.scan(); f.tick(101); await f.scanner.scan();
    const input = f.executor.run.mock.calls[0][0];
    expect(input.context?.totalItems).toBe(80); expect(input.context?.omittedItems).toBeGreaterThan(0);
    expect(input.board.items.length).toBeLessThanOrEqual(50);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThanOrEqual(f.options.policy.maxInputBytes);
    expect((await f.service.read('b')).items.find(i => i.id === 'export')?.status).toBe('proposed');
});
it('keeps archived history out of the active scan board while supplying explicit historical summaries', async () => {
    const f = await fixture();
    await f.service.execute('b', {operationId: 'old', expectedRevision: (await f.service.read('b')).revision,
        command: {type: 'create-item', item: {id: 'old', title: 'Old export', responsibility: 'Previous scope', acceptance: 'Old evidence', eligibleAgentIds: ['worker']}}});
    for (const command of [{type: 'cancel-item', itemId: 'old', reason: 'Superseded'}, {type: 'archive-items', itemIds: ['old'], reason: 'History'}] as const) {
        await f.service.execute('b', {operationId: command.type, expectedRevision: (await f.service.read('b')).revision, command: structuredClone(command) as never});
    }
    await f.scanner.scan(); f.tick(101); await f.scanner.scan();
    const input = f.executor.run.mock.calls[0][0];
    expect(input.board.items).toEqual([]); expect(input.context?.archivedItems[0].id).toBe('old');
    expect(input.context?.archivedItems[0]).not.toHaveProperty('responsibility');
});
it('extracts source-validated context drafts in the same transaction as source watermarks', async () => {
    const f = await fixture(); f.executor.run.mockResolvedValueOnce({changes: [], records: [{id: 'decision', kind: 'decision', title: 'Limit scope', content: 'Only implement export', rationale: 'Keep delivery bounded', itemIds: [],
        sources: [{sessionId: 's', messageId: 'm', revision: 'r1', role: 'user'}]}]} as never);
    await f.scanner.scan(); f.tick(101); await f.scanner.scan();
    expect((await f.service.record('b', 'decision')).status).toBe('draft');
    expect((await f.store.read('b'))!.discovery!.checkpoints.s).toBe('r1');
    expect((await f.service.read('b')).items).toHaveLength(0);
});
it('rejects invented context citations without advancing session watermarks', async () => {
    const f = await fixture(); f.executor.run.mockResolvedValueOnce({changes: [], records: [{id: 'log', kind: 'log', title: 'Progress', content: 'No verified evidence', itemIds: [],
        sources: [{sessionId: 's', messageId: 'invented', revision: 'r1', role: 'user'}]}]} as never);
    await f.scanner.scan(); f.tick(101); await expect(f.scanner.scan()).rejects.toThrow('INVALID_SOURCE_REFERENCE');
    expect((await f.store.read('b'))!.discovery!.checkpoints).toEqual({}); expect((await f.service.records('b')).total).toBe(0);
});
