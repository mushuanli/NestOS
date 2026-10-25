/**
 * Reopening must preserve the assistant position after a host stops during a model call.
 * Graceful shutdown may persist a real terminal failure before reopening; otherwise the
 * unfinished Round must remain identifiable. Neither outcome permits inventing a terminal
 * result merely to release input. Real SIGKILL recovery is covered by the CLI crash matrix.
 */
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { createApplicationRuntime } from '@itookit/app-core';
import { SessionCommand } from '@itookit/llm-session';
import { createAgentSendIntent } from '@itookit/llm-flow/contracts';
import { FakeSidecarDb } from './fake-sidecar';

/** Point the global default connection at a local endpoint that accepts the request and never answers. */
async function seedHangingProvider(root: string, port: number): Promise<void> {
    const etc = join(root, 'data', 'etc', 'llm');
    await mkdir(join(etc, '.providers'), { recursive: true });
    await mkdir(join(etc, '.connections'), { recursive: true });
    await writeFile(join(etc, '.connection-settings.json'), JSON.stringify({ defaultConnectionId: 'default' }));
    await writeFile(join(etc, '.providers', 'mock.json'), JSON.stringify({
        id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${port}`, models: [{ id: 'mock-model', name: 'mock-model' }],
    }));
    await writeFile(join(etc, '.connections', 'default.json'), JSON.stringify({
        id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' },
    }));
}

async function dispatch(runtime: Awaited<ReturnType<typeof createApplicationRuntime>>, sessionId: string, text: string): Promise<unknown> {
    return runtime.commandBus.execute(SessionCommand.Send, {
        text, files: [], agentId: 'default', sendIntent: createAgentSendIntent('default'),
    }).then(() => undefined, error => error);
}

it('keeps the Session sendable after disposing and reopening a host during an in-flight run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mindos-restart-inflight-'));
    const requests: string[] = [];
    const model = createServer(request => { requests.push(request.url ?? ''); });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as { port: number }).port;
    const sidecar = new FakeSidecarDb();
    const openBackend = () => openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db'), createDb: async () => sidecar });
    await seedHangingProvider(root, port);

    let sessionId = '';
    const first = await createApplicationRuntime({ backend: await openBackend(), ownerKind: 'tauri' });
    try {
        sessionId = await first.sessionRepository.createSession('Session');
        await first.commandBus.execute(SessionCommand.Bind, { sessionId });
        void dispatch(first, sessionId, 'a question that never finishes');
        // The model call is in flight; graceful disposal may persist its real failure.
        await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 20_000 });
    } finally { await first.dispose(); }
    model.closeAllConnections?.();
    await new Promise<void>(resolve => model.close(() => resolve()));

    const second = await createApplicationRuntime({ backend: await openBackend(), ownerKind: 'tauri' });
    try {
        await second.commandBus.execute(SessionCommand.Bind, { sessionId });
        const snapshot = second.sessionManager.getSnapshot();
        const tail = snapshot.sessions.at(-1);
        // The transcript must not end on the user message, otherwise the next send is refused.
        expect(tail?.role, JSON.stringify(snapshot.sessions.map(entry => [entry.role, entry.executionRoot?.status]))).toBe('assistant');
        // Compare against persisted history, rather than inventing an unfinished outcome.
        const {rounds} = await second.sessionRepository.readHistoryChain(sessionId);
        expect(rounds).toHaveLength(1);
        const projected = {running: 'running', failed: 'failed', cancelled: 'aborted'};
        expect(Object.keys(projected)).toContain(rounds[0].status);
        expect(tail?.executionRoot?.status).toBe(projected[rounds[0].status as keyof typeof projected]);
        expect(snapshot.interruptedAssistantId).toBe(rounds[0].status === 'running' ? tail?.id : undefined);

        const failure = await dispatch(second, sessionId, 'the next question');
        expect(String(failure ?? '')).not.toContain('consecutive');
    } finally { await second.dispose(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
