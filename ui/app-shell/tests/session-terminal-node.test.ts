import { expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '@itookit/app-core';
import { SessionCommand, type SessionEventEnvelope } from '@itookit/llm-session';
import { createAgentSendIntent } from '@itookit/llm-flow/contracts';

it.each(['failed', 'aborted'])('addresses %s status to the mounted assistant and preserves cancellation identity', async status => {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    await backend.write('/etc/llm/.providers/mock.json', encode({ id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'test', baseURL: 'http://localhost:18449', models: [{ id: 'mock-model', name: 'Mock' }] }));
    await backend.write('/etc/llm/.connections/default.json', encode({ id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' } }));
    await backend.write('/etc/llm/.connection-settings.json', encode({ defaultConnectionId: 'default' }));
    let failRequest!: () => void;
    const fetch = vi.fn((_url: unknown, options: RequestInit) => new Promise((resolve, reject) => {
        // A permanent provider error reaches terminal status without entering durable retries.
        failRequest = () => resolve(new Response(JSON.stringify({ error: { message: 'Invalid model request' } }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        }));
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri' });
    const events: SessionEventEnvelope[] = [];
    try {
        const sessionId = await runtime.sessionRepository.createSession('Failure');
        await runtime.commandBus.execute(SessionCommand.Bind, { sessionId });
        const unsubscribe = runtime.sessionManager.onEvent(event => events.push(event));
        try {
            await runtime.commandBus.execute(SessionCommand.Send, {
                text: 'hello', files: [], agentId: 'default', sendIntent: createAgentSendIntent('default'),
            }).catch(() => {});
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
            if (status === 'aborted') await runtime.commandBus.execute(SessionCommand.Abort);
            else failRequest();
            await vi.waitFor(() => expect(events.some(event => event.type === 'message:status' && event.payload.status === status)).toBe(true));
        } finally { unsubscribe(); }
        const error = events.find(event => event.type === 'error');
        expect(error).toBeDefined();
        if (error?.type === 'error') expect(error.payload.error.code).toBe(status === 'aborted' ? 'ABORTED' : undefined);
        const appended = events.find(event => event.type === 'message:appended' && event.payload.isExecutionRoot);
        expect(appended).toBeDefined();
        if (appended?.type !== 'message:appended') throw new Error('Missing assistant');
        const root = appended.payload.sessionGroup.executionRoot!;
        const terminal = events.filter(event => event.type === 'message:status' && event.payload.status === status);
        expect(terminal.length).toBeGreaterThan(0);
        for (const event of terminal) {
            if (event.type === 'message:status') expect(event.payload.messageId).toBe(root.id);
        }
    } finally { await runtime.dispose(); vi.unstubAllGlobals(); }
});
