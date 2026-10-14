/**
 * P0-02：宿主在运行途中消失（进程被强杀/崩溃）后重开时，会话不能卡死。
 *
 * 此前只有「终态且无输出的 round」会投影出助手占位；一个已记录 execution 但仍为
 * `running` 的 round（拥有它的宿主已不在）不会投影任何助手消息，于是重开后转写以用户
 * 消息结尾，下一次发送被 `Cannot send consecutive user messages` 拒绝。
 *
 * 用真实本地存储根跑两个宿主实例；模型服务是一个**永不回包**的本地 HTTP 服务，
 * 以保证第一个宿主退出时运行确实仍在途中。
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

it('keeps the Session sendable when a host dies while its run is still in flight', async () => {
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
        // The model call is in flight — this host is now killed without settling the run.
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
        // The interrupted run is offered again (regenerate) rather than silently forgotten.
        expect(snapshot.interruptedAssistantId).toBeTruthy();

        const failure = await dispatch(second, sessionId, 'the next question');
        expect(String(failure ?? '')).not.toContain('consecutive');
    } finally { await second.dispose(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
