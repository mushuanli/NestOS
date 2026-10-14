import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, registerDurablePrograms } from '@itookit/llm-flow';
import { LlmChatEffectAdapter } from '../../kernel-adapters/src/effects/llm-chat-effect';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';

it('projects content while the model stream is still waiting for more data', async () => {
    let releaseThinking!: () => void;
    const thinkingGate = new Promise<void>(resolve => { releaseThinking = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    kernel.registerEffect(new LlmChatEffectAdapter({ async *chatStream() {
        yield { choices: [{ index: 0, delta: { thinking: 'THINKING' }, finish_reason: null }] };
        await thinkingGate;
        yield { choices: [{ index: 0, delta: { content: 'FIRST' }, finish_reason: null }] };
        await gate;
        yield { choices: [{ index: 0, delta: { content: ' LAST' }, finish_reason: 'stop' }] };
    } } as never));
    await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    const emitSession = vi.fn(), finalize = vi.fn(async () => {});
    const coordinator = new ConversationRunCoordinator({ kernel, dagPlugins: createBuiltinDagPluginRegistry(),
        eventBus: { emitSession, emitGlobal: vi.fn() }, engine: {}, loadArtifact: async () => null } as never);
    const internal = coordinator as any;
    vi.spyOn(internal.contextBuilder, 'resolveLocation').mockResolvedValue({ branchRef: 'main', branchHead: null });
    vi.spyOn(internal.contextBuilder, 'assemble').mockResolvedValue({ blocks: [], canonicalMessages: [] });
    for (const name of ['startRound', 'completeRound', 'failRound']) vi.spyOn(internal, name).mockResolvedValue(undefined);
    const running = coordinator.executeDag({ task: { sessionId: 's', input: { text: 'go', sendIntent: { execution: { kind: 'flow' } } } },
        rootNodeId: 'root', roundId: 'round', finalize, contextFiles: [], state: { updateNodeMeta() {}, appendToNode() {}, appendChildNode() {}, updateNodeOutput() {}, updateNodeStatus() {} } } as never,
        {}, () => ({ nodes: [{ id: 'writer', name: 'Writer', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { connectionId: 'default', approval: 'none', maxExchanges: 1, messages: [{ role: 'user', content: 'go' }] } }], edges: [] }));
    try {
        await vi.waitFor(() => expect(emitSession.mock.calls.some(([, event]) => event.type === 'message:updated' && event.payload.field === 'thought' && event.payload.delta === 'THINKING')).toBe(true), { timeout: 3000 });
        expect(emitSession.mock.calls.some(([, event]) => event.type === 'message:updated' && event.payload.field === 'output')).toBe(false);
        expect(finalize).not.toHaveBeenCalled();
        const requestUpdate = emitSession.mock.calls.find(([, event]) => event.payload?.metaInfo?.requests);
        expect(requestUpdate?.[1].payload.metaInfo.requests[0]).toMatchObject({ connectionId: 'default', request: { messages: expect.arrayContaining([{ role: 'user', content: 'go' }]) } });
        releaseThinking();
        await vi.waitFor(() => expect(emitSession.mock.calls.some(([, event]) => event.type === 'message:updated' && event.payload.delta === 'FIRST')).toBe(true), { timeout: 3000 });
        expect(finalize).not.toHaveBeenCalled();
        expect((await kernel.listSessionTasks('s')).some(task => task.program.kind === 'llm.agent' && task.status !== 'succeeded')).toBe(true);
    } finally { releaseThinking(); release(); await running; kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); vi.unstubAllGlobals(); }
    expect(finalize).toHaveBeenCalledOnce();
});
