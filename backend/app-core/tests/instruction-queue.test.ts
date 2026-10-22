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

function model() {
    const requests: Array<{ messages: Array<{role: string; content: string}> }> = [], release: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        requests.push(JSON.parse(options.body));
        await new Promise<void>((resolve, reject) => {
            release.push(resolve);
            options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        return new Response(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'previous answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return { requests, release };
}

function message(text: string) {
    return { text, files: [], agentId: 'default', overrides: { executionMode: 'chat', streamMode: false, webSearchEnabled: false } };
}

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
