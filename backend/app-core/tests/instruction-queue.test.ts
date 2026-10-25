import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { SessionCommand, type SessionInstructionQueue } from '@itookit/llm-session/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

afterEach(() => vi.unstubAllGlobals());

async function storage() {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', { id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture-key',
        baseURL: 'http://localhost:18449', models: [{ id: 'mock-model', name: 'Mock' }] });
    await write('/etc/llm/.connections/default.json', { id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' } });
    await write('/etc/llm/.connection-settings.json', { defaultConnectionId: 'default' });
    return backend;
}

function model(firstFails = false) {
    const requests: Array<{ messages: Array<{role: string; content: string}> }> = [], release: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        requests.push(JSON.parse(options.body));
        await new Promise<void>((resolve, reject) => {
            release.push(resolve);
            options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        if (firstFails && requests.length === 1) return new Response(JSON.stringify({error: {message: 'Rejected fixture request'}}),
            {status: 400, headers: {'content-type': 'application/json'}});
        return new Response(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'previous answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return { requests, release };
}

function message(text: string) {
    return { text, files: [], agentId: 'default', overrides: { executionMode: 'chat', streamMode: false, webSearchEnabled: false } };
}

it.each([false, true])('keeps a model call terminal and creates a linked Invocation on user rerun (failed: %s)', async failed => {
    const mock = model(failed), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Invocation history');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await view.commandBus.execute(SessionCommand.Send, message('Original request'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        const claim = view.sessionManager.getSnapshot().instructionQueue!.items[0].invocation!;
        expect(claim.invocationId).toBeTruthy(); mock.release[0]();
        await vi.waitFor(async () => {
            expect((await runtime.sessionRepository.readHistoryChain(id)).rounds[0].status).toBe(failed ? 'failed' : 'completed');
            expect(view.sessionManager.isGenerating()).toBe(false);
        });
        const original = (await runtime.sessionRepository.readHistoryChain(id)).rounds[0];
        expect(original.executions[0].invocation).toEqual(claim);
        const oldTask = (await (await runtime.kernel.kernel.openTask(original.executions[0].taskId)).status()).task;
        expect(oldTask.labels?.invocationId).toBe(claim.invocationId);
        const document = await runtime.sessionRepository.readDocument(id, `round-${original.id}.json`);
        expect(document).not.toBeNull();
        await view.sessionManager.regenerateFromUser(`round-${original.id}-user`);
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2));
        const next = (await runtime.sessionRepository.readHistoryChain(id)).rounds.at(-1)!;
        const identity = next.executions[0].invocation!;
        expect(next.id).not.toBe(original.id); expect(identity.invocationId).not.toBe(claim.invocationId);
        expect(identity).toMatchObject({retryOfInvocationId: claim.invocationId, retryOfSessionId: id});
        const user = view.sessionManager.getSessions().find(group => group.persistedNodeId === next.id && group.role === 'user');
        expect(user?.invocation).toEqual(identity);
        mock.release[1]();
        await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds.at(-1)?.status).toBe('completed'));
        expect(await runtime.sessionRepository.readDocument(id, `round-${original.id}.json`)).toBe(document);
        expect((await (await runtime.kernel.kernel.openTask(original.executions[0].taskId)).status()).task).toEqual(oldTask);
    } finally {mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose();}
}, 20000);

it('durably accepts simultaneous sends from idle views and publishes one shared queue projection', async () => {
    const mock = model(), backend = await storage();
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
    const first = await runtime.createView(), second = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Concurrent views');
        await first.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await second.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        const observed = vi.fn(); const stop = second.sessionManager.onEvent(observed);
        const ids = await Promise.all([first.commandBus.execute<string>(SessionCommand.Send, message('first')),
            second.commandBus.execute<string>(SessionCommand.Send, message('second'))]);
        const queue = second.sessionManager.getSnapshot().instructionQueue!;
        expect(queue.items.map(item => item.id)).toEqual(ids);
        expect(queue.items.map(item => item.state)).toEqual(['dispatching', 'pending']);
        expect(observed.mock.calls.some(([event]) => event.type === 'instructions:changed')).toBe(true);
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        const destroyed = vi.spyOn(first.sessionManager, 'destroy');
        await first.dispose(); expect(destroyed).not.toHaveBeenCalled(); mock.release[0]();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2), { timeout: 10000 }); mock.release[1]();
        await vi.waitFor(() => expect(second.sessionManager.getSnapshot().instructionQueue?.items).toEqual([]));
        await vi.waitFor(() => expect(destroyed).toHaveBeenCalledOnce());
        stop();
    } finally { mock.release.forEach(release => release()); await first.dispose(); await second.dispose(); await runtime.dispose(); }
}, 20000);

it('commits the idle request before the model is called and never executes after queue persistence fails', async () => {
    const mock = model(), runtime = await createApplicationRuntime({ backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false });
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Durable ingress');
        await view.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        const open = runtime.kernel.kernel.openSession.bind(runtime.kernel.kernel);
        const failed = vi.spyOn(runtime.kernel.kernel, 'openSession').mockImplementation(async (...args) => {
            const handle = await open(...args);
            return new Proxy(handle, { get(target, key) {
                if (key === 'setShared') return async (name: string, ...rest: unknown[]) => {
                    if (name === 'conversation/instructions') throw new Error('queue storage unavailable');
                    return Reflect.apply(target.setShared, target, [name, ...rest]);
                };
                const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
            } });
        });
        await expect(view.commandBus.execute(SessionCommand.Send, message('not accepted'))).rejects.toThrow('queue storage unavailable');
        expect(mock.requests).toHaveLength(0); failed.mockRestore();
        const request = await view.commandBus.execute<string>(SessionCommand.Send, message('accepted'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        expect((await view.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items[0]).toMatchObject({ id: request, state: 'dispatching' });
        mock.release[0]();
    } finally { mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose(); }
}, 20000);

it('keeps a queued default connection when the system default changes before dispatch', async () => {
    const mock = model();
    const runtime = await createApplicationRuntime({ backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false });
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Frozen default');
        await view.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await view.commandBus.execute(SessionCommand.Send, message('first'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        await view.commandBus.execute(SessionCommand.Send, message('queued'));
        const queue = await view.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        expect(queue.items[0].connectionBinding).toMatchObject({ connectionId: 'default', defaults: { chat: 'default' } });
        await runtime.agentService.saveProvider({ id: 'other', name: 'Other', implementation: 'openai-compatible', apiKey: 'fixture-key',
            baseURL: 'http://localhost:18449', models: [{ id: 'other-model', name: 'Other' }] });
        await runtime.agentService.saveConnection({ id: 'other', name: 'Other', providerId: 'other', tiers: { optimal: 'other-model' } });
        await runtime.agentService.setDefaultConnection('other'); mock.release[0]();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2), { timeout: 10000 });
        expect((mock.requests[1] as unknown as { model: string }).model).toBe('mock-model');
        mock.release[1]();
    } finally { mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose(); }
}, 20000);

it('dispatches the admitted Agent identity after scope and prompt edits while rejecting new local submissions', async () => {
    const mock = model(), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    const definition = {id: 'writer', name: 'Writer', type: 'agent' as const, exposure: 'global' as const,
        config: {systemPrompt: 'ORIGINAL_FROZEN_POLICY'}, capabilityPolicy: {toolIds: [], mcpProfileIds: []}};
    try {
        await runtime.agentService.saveAgent(definition);
        const sessionId = await runtime.sessionRepository.createSession('Frozen Agent');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId});
        await view.commandBus.execute(SessionCommand.Send, message('first'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        const queuedId = await view.commandBus.execute<string>(SessionCommand.Send, {...message('queued'), agentId: 'writer'});
        const session = await runtime.kernel.kernel.inspectSession(sessionId), shared = await session.getShared('conversation/instructions');
        const stored = (shared!.value as any).items.find((item: any) => item.id === queuedId);
        expect(stored.connectionBinding.agent.config).toMatchObject({id: 'writer', exposure: 'global', systemPrompt: ['ORIGINAL_FROZEN_POLICY']});
        expect((await view.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items
            .find(item => item.id === queuedId)?.connectionBinding).not.toHaveProperty('agent');
        await runtime.agentService.saveAgent({...definition, exposure: 'local', config: {systemPrompt: 'CHANGED_POLICY'}});
        await expect(view.commandBus.execute(SessionCommand.Send, {...message('new local call'), agentId: 'writer'}))
            .rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
        mock.release[0](); await vi.waitFor(() => expect(mock.requests).toHaveLength(2), {timeout: 10000});
        const messages = JSON.stringify(mock.requests[1].messages);
        expect(messages).toContain('ORIGINAL_FROZEN_POLICY'); expect(messages).not.toContain('CHANGED_POLICY');
        mock.release[1]();
    } finally {mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose();}
}, 20000);

it('does not infer new target facts when dispatching a legacy queue without an accepted identity version', async () => {
    const mock = model(), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        const sessionId = await runtime.sessionRepository.createSession('Legacy target identity');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId});
        await view.commandBus.execute(SessionCommand.Send, message('First request'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        const queuedId = await view.commandBus.execute<string>(SessionCommand.Send, message('Legacy request'));
        const session = await runtime.kernel.kernel.openSession(sessionId), shared = await session.getShared('conversation/instructions');
        const saved = structuredClone(shared!.value) as {items: Array<{id: string; connectionBinding: {identityVersion?: number; agent?: unknown}}>};
        const queued = saved.items.find(item => item.id === queuedId)!;
        delete queued.connectionBinding.identityVersion; delete queued.connectionBinding.agent;
        await session.setShared('conversation/instructions', saved, {expectedVersion: shared!.version});
        mock.release[0](); await vi.waitFor(() => expect(mock.requests).toHaveLength(2), {timeout: 10000});
        mock.release[1]();
        await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(sessionId)).rounds.at(-1)?.status).toBe('completed'));
        const legacy = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds.at(-1)!;
        expect(legacy.id).toBe(queuedId); expect(legacy.target).toBeUndefined();
        const task = (await (await runtime.kernel.kernel.openTask(legacy.executions[0].taskId)).status()).task;
        expect(task.labels).not.toHaveProperty('targetKind'); expect(task.labels).not.toHaveProperty('targetDigest');
    } finally {mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose();}
}, 20000);

it('drains a reordered and merged queue after view detachment, using the preceding persisted answer', async () => {
    const mock = model();
    const runtime = await createApplicationRuntime({ backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false });
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Queued chat');
        await view.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await view.commandBus.execute(SessionCommand.Send, message('first'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        const a = await view.commandBus.execute<string>(SessionCommand.Send, message('second'));
        const b = await view.commandBus.execute<string>(SessionCommand.Send, message('third'));
        const c = await view.commandBus.execute<string>(SessionCommand.Send, message('deleted'));
        const queue = () => view.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        const edit = async (change: object) => view.commandBus.execute(SessionCommand.EditInstructionQueue, { ...change, expectedRevision: (await queue()).revision });
        expect((await queue()).items.filter(item => item.state === 'pending').map(item => item.text)).toEqual(['second', 'third', 'deleted']);
        await edit({ action: 'remove', id: c });
        await edit({ action: 'reorder', ids: [b, a] });
        await edit({ action: 'merge', ids: [a, b] });
        expect(mock.requests).toHaveLength(1);
        await view.dispose();
        mock.release[0]();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2), { timeout: 10000 });
        expect(mock.requests[1].messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'first' }),
            expect.objectContaining({ role: 'assistant', content: 'previous answer' }),
            expect.objectContaining({ role: 'user', content: 'third\n\nsecond' }),
        ]));
        mock.release[1]();
        await vi.waitFor(async () => {
            const session = await runtime.kernel.kernel.inspectSession(id);
            expect((await session.getShared('conversation/instructions'))?.value).toMatchObject({ items: [] });
        }, { timeout: 10000 });
        const chain = await runtime.sessionRepository.readHistoryChain(id);
        expect(chain.rounds).toHaveLength(2);
        expect(chain.rounds.map(round => ({ status: round.status, error: round.error }))).toEqual([
            { status: 'completed', error: undefined }, { status: 'completed', error: undefined },
        ]);
        expect(mock.requests).toHaveLength(2);
    } finally { mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose(); }
}, 20000);

it('coordinates different host views so a queued instruction cannot run before the current round commits', async () => {
    const mock = model();
    const runtime = await createApplicationRuntime({ backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false });
    const first = await runtime.createView(), second = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Two clients');
        await first.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await second.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await first.commandBus.execute(SessionCommand.Send, message('first'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        await second.commandBus.execute(SessionCommand.Send, message('queued from another view'));
        expect(mock.requests).toHaveLength(1);
        mock.release[0]();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2), { timeout: 10000 });
        expect(mock.requests[1].messages.some(item => item.role === 'assistant' && item.content === 'previous answer')).toBe(true);
        mock.release[1]();
        await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(id)).rounds.every(round => round?.status === 'completed')).toBe(true));
    } finally { mock.release.forEach(release => release()); await first.dispose(); await second.dispose(); await runtime.dispose(); }
}, 20000);

it('recovers persisted pending instructions at host startup and sends after Session resume without an editor', async () => {
    const mock = model(), backend = await storage();
    const closeStorage = vi.spyOn(backend, 'close').mockResolvedValue(undefined);
    let runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
    try {
        const id = await runtime.sessionRepository.createSession('Recovered queue');
        await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await (await runtime.kernel.kernel.openSession(id)).suspend();
        await runtime.commandBus.execute(SessionCommand.Send, message('Send after restart'));
        expect(mock.requests).toHaveLength(0);
        await runtime.dispose();
        runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri', digitalTwinAutoStart: false });
        expect(runtime.sessionManager.getCurrentSessionId()).toBeNull();
        await (await runtime.kernel.kernel.openSession(id)).resume();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1), { timeout: 10000 });
        mock.release[0]();
        await vi.waitFor(async () => {
            const session = await runtime.kernel.kernel.inspectSession(id);
            expect((await session.getShared('conversation/instructions'))?.value).toMatchObject({ items: [] });
        }, { timeout: 10000 });
        expect((await runtime.sessionRepository.readHistoryChain(id)).rounds).toHaveLength(1);
    } finally { mock.release.forEach(release => release()); await runtime.dispose(); closeStorage.mockRestore(); await backend.close(); }
}, 20000);

it('stops the active view and pauses queued instructions when another view requests cancellation', async () => {
    const mock = model();
    const runtime = await createApplicationRuntime({ backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false });
    const first = await runtime.createView(), second = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Stop queue');
        await first.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await second.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await first.commandBus.execute(SessionCommand.Send, message('current'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        await second.commandBus.execute(SessionCommand.Send, message('keep for later'));
        await second.commandBus.execute(SessionCommand.Abort);
        await vi.waitFor(async () => {
            const queue = await second.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
            expect(queue).toMatchObject({ paused: true }); expect(queue.items.map(item => item.text)).toEqual(['keep for later']);
            expect(first.sessionManager.isGenerating()).toBe(false);
        }, { timeout: 10000 });
        expect(mock.requests).toHaveLength(1);
    } finally { mock.release.forEach(release => release()); await first.dispose(); await second.dispose(); await runtime.dispose(); }
}, 20000);

it('recovers a frozen Agent after runtime restart without adopting later scope or prompt changes', async () => {
    const mock = model(), backend = await storage(), closeStorage = vi.spyOn(backend, 'close').mockResolvedValue(undefined);
    let runtime = await createApplicationRuntime({backend, ownerKind: 'tauri', digitalTwinAutoStart: false});
    try {
        const definition = {id: 'writer', name: 'Writer', type: 'agent' as const, exposure: 'global' as const,
            config: {systemPrompt: 'BEFORE_RESTART_POLICY'}};
        await runtime.agentService.saveAgent(definition);
        const id = await runtime.sessionRepository.createSession('Recover frozen identity');
        await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await (await runtime.kernel.kernel.openSession(id)).suspend();
        await runtime.commandBus.execute(SessionCommand.Send, {...message('Queued before restart'), agentId: 'writer'});
        await runtime.agentService.saveAgent({...definition, exposure: 'local', config: {systemPrompt: 'AFTER_RESTART_POLICY'}});
        expect(mock.requests).toHaveLength(0); await runtime.dispose();
        runtime = await createApplicationRuntime({backend, ownerKind: 'tauri', digitalTwinAutoStart: false});
        expect(runtime.sessionManager.getCurrentSessionId()).toBeNull();
        await (await runtime.kernel.kernel.openSession(id)).resume();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1), {timeout: 10000});
        expect(JSON.stringify(mock.requests[0].messages)).toContain('BEFORE_RESTART_POLICY');
        expect(JSON.stringify(mock.requests[0].messages)).not.toContain('AFTER_RESTART_POLICY'); mock.release[0]();
        await vi.waitFor(async () => expect((await (await runtime.kernel.kernel.inspectSession(id))
            .getShared('conversation/instructions'))?.value).toMatchObject({items: []}), {timeout: 10000});
    } finally {mock.release.forEach(release => release()); await runtime.dispose(); closeStorage.mockRestore(); await backend.close();}
}, 20000);

it('acknowledges a retried active or completed submission instead of queueing the same paid request again', async () => {
    const mock = model();
    const runtime = await createApplicationRuntime({ backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false });
    const first = await runtime.createView(), second = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Stable submission');
        await first.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await second.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        const request = { ...message('one request'), sendIntent: { execution: { kind: 'agent', agentId: 'default', mode: 'chat' },
            branch: { mode: 'continue' }, retention: { mode: 'persistent' },
            submission: { id: 'stable-request', source: { kind: 'conversation', ownerId: id, id: 'stable-request' } } } };
        await first.commandBus.execute(SessionCommand.Send, request);
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        await expect(second.commandBus.execute(SessionCommand.Send, { ...request, text: 'different request' })).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
        expect(await second.commandBus.execute(SessionCommand.Send, request)).toBe('stable-request');
        expect((await second.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toMatchObject([{ id: 'stable-request', state: 'dispatching' }]);
        mock.release[0]();
        await vi.waitFor(() => expect(first.sessionManager.isGenerating()).toBe(false));
        await first.sessionManager.waitForInstructionWrites();
        const session = await runtime.kernel.kernel.openSession(id), stored = await session.getShared('conversation/instructions');
        await session.setShared('conversation/instructions', { ...(stored!.value as object), accepted: [] }, { expectedVersion: stored!.version });
        expect(await second.commandBus.execute(SessionCommand.Send, request)).toBe('stable-request');
        await expect(second.commandBus.execute(SessionCommand.Send, { ...request, text: 'changed after completion' })).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
        expect(mock.requests).toHaveLength(1);
    } finally { mock.release.forEach(release => release()); await first.dispose(); await second.dispose(); await runtime.dispose(); }
}, 20000);

it('sends verified current and historical attachment bytes in actual model requests', async () => {
    const mock = model(), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Verified attachments');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await view.commandBus.execute(SessionCommand.Send, {...message('Read this file'),
            files: [{name: 'notes.txt', type: 'text/plain', fileRef: new Blob(['unique-file-material'])},
                {name: 'pixel.png', type: 'image/png', fileRef: new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yAAAAABJRU5ErkJggg==', 'base64')])}]});
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        expect(JSON.stringify(mock.requests[0].messages)).toContain('unique-file-material');
        expect(JSON.stringify(mock.requests[0].messages)).toContain('data:image/png;base64,iVBORw0KGgo');
        const history = await runtime.sessionRepository.readHistoryChain(id);
        expect(history.rounds[0].input[0].attachments?.[0]).toMatchObject({mimeType: 'text/plain', type: 'file',
            options: {contentIdentity: {bytes: 20, sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}}});
        mock.release[0]();
        await vi.waitFor(() => expect(view.sessionManager.isGenerating()).toBe(false));
        await view.commandBus.execute(SessionCommand.Send, message('Refer to that file again'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2));
        expect(JSON.stringify(mock.requests[1].messages)).toContain('unique-file-material');
        expect(JSON.stringify(mock.requests[1].messages)).toContain('data:image/png;base64,iVBORw0KGgo');
        mock.release[1]();
    } finally {mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose();}
}, 20000);

it('preserves queued bytes after the upload changes and blocks paid work when the frozen copy is corrupted', async () => {
    const mock = model(), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Queued attachment isolation');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await view.commandBus.execute(SessionCommand.Send, message('Hold the first call'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        await runtime.sessionRepository.writeAttachment(id, 'shared.txt', new TextEncoder().encode('original-file').buffer);
        const second = await view.commandBus.execute<string>(SessionCommand.Send, {...message('Queued file'), files: [{name: 'shared.txt', type: 'text/plain', size: 13}]});
        const secondFile = view.sessionManager.getSnapshot().instructionQueue!.items.find(item => item.id === second)!.files[0];
        expect(secondFile.name).not.toBe('shared.txt'); expect(secondFile.content?.bytes).toBe(13);
        const assets = await runtime.sessionRepository.openAttachments(id);
        try {await assets.driver.createFile({name: 'shared.txt', parentPath: '/', content: new TextEncoder().encode('changed-file!').buffer, overwrite: true});}
        finally {await assets.dispose();}
        const third = await view.commandBus.execute<string>(SessionCommand.Send, {...message('Corrupt copy'), files: [{name: 'third.txt', type: 'text/plain', fileRef: new Blob(['third-file'])}]});
        const thirdFile = view.sessionManager.getSnapshot().instructionQueue!.items.find(item => item.id === third)!.files[0];
        const corrupt = await runtime.sessionRepository.openAttachments(id);
        try {await corrupt.driver.createFile({name: thirdFile.name, parentPath: '/', content: new TextEncoder().encode('wrong-file').buffer, overwrite: true});}
        finally {await corrupt.dispose();}
        mock.release[0]();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2), {timeout: 10000});
        expect(JSON.stringify(mock.requests[1].messages)).toContain('original-file');
        expect(JSON.stringify(mock.requests[1].messages)).not.toContain('changed-file!');
        mock.release[1]();
        await vi.waitFor(() => expect(view.sessionManager.getSnapshot().instructionQueue?.items).toMatchObject([{id: third, state: 'failed',
            error: expect.stringContaining('Attachment content changed')}]), {timeout: 10000});
        expect(mock.requests).toHaveLength(2);
    } finally {mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose();}
}, 20000);

it('rejects missing declared and explicit Markdown attachments before durable acceptance or model execution', async () => {
    const mock = model(), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Missing attachment');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await expect(view.commandBus.execute(SessionCommand.Send, {...message('Read'), files: [{name: 'missing.txt', type: 'text/plain'}]}))
            .rejects.toMatchObject({code: 'ATTACHMENT_NOT_FOUND'});
        await expect(view.commandBus.execute(SessionCommand.Send, message('[file](@asset/missing.txt)')))
            .rejects.toMatchObject({code: 'ATTACHMENT_NOT_FOUND'});
        expect(mock.requests).toHaveLength(0);
        expect(view.sessionManager.getSnapshot().instructionQueue?.items ?? []).toEqual([]);
    } finally {await view.dispose(); await runtime.dispose();}
}, 20000);

it('freezes newly referenced files during queue edits and preserves the prior revision on missing input', async () => {
    const mock = model(), runtime = await createApplicationRuntime({backend: await storage(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    const view = await runtime.createView();
    try {
        const id = await runtime.sessionRepository.createSession('Editable attachment references');
        await view.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await view.commandBus.execute(SessionCommand.Send, message('Keep running'));
        await vi.waitFor(() => expect(mock.requests).toHaveLength(1));
        const queued = await view.commandBus.execute<string>(SessionCommand.Send, message('Next instruction'));
        const before = view.sessionManager.getSnapshot().instructionQueue!;
        await expect(view.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: before.revision,
            action: 'update', id: queued, text: '[missing](@asset/missing.txt)'})).rejects.toMatchObject({code: 'ATTACHMENT_NOT_FOUND'});
        expect(view.sessionManager.getSnapshot().instructionQueue).toEqual(before);
        await runtime.sessionRepository.writeAttachment(id, 'added.txt', new TextEncoder().encode('added-material').buffer);
        await view.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: before.revision,
            action: 'update', id: queued, text: 'Read [file](@asset/added.txt)'});
        const item = view.sessionManager.getSnapshot().instructionQueue!.items.find(item => item.id === queued)!;
        expect(item.files[0].content?.bytes).toBe(14);
        expect(item.text).toContain(`@asset/${item.files[0].name}`);
        expect(item.submissionDigest).toBe(before.items.find(item => item.id === queued)!.submissionDigest);
        mock.release[0]();
        await vi.waitFor(() => expect(mock.requests).toHaveLength(2), {timeout: 10000});
        expect(JSON.stringify(mock.requests[1].messages)).toContain('added-material'); mock.release[1]();
    } finally {mock.release.forEach(release => release()); await view.dispose(); await runtime.dispose();}
}, 20000);
