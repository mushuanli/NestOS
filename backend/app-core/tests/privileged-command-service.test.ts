import { describe, expect, it, vi } from 'vitest';
import type { Kernel, TaskHandle } from '@itookit/durable-kernel';
import type { IAgentConfigService } from '@itookit/llm-session';
import { PrivilegedCommandService } from '../src/kernel/privileged-command-service';

describe('PrivilegedCommandService', () => {
    it('submits and capability-binds a durable plan task', async () => {
        const fixture = createFixture();
        const service = new PrivilegedCommandService(fixture.kernel, agentService());

        const id = await service.plan({ sessionId: 'session-1', agentId: 'agent-1', goal: 'Ship it' });

        expect(id).toBe('task-1');
        expect(fixture.submit).toHaveBeenCalledWith(expect.objectContaining({
            program: { kind: 'llm.plan', version: '1' },
            input: expect.objectContaining({ goal: 'Ship it', connectionId: 'connection-1' }),
            deferStart: true,
        }));
        expect(fixture.task.start).toHaveBeenCalledWith({
            signal: { type: 'capabilities', payload: { llmHandleId: 'handle-1' } },
        });
        expect(fixture.task.signal).not.toHaveBeenCalled();
        expect(fixture.task.start).toHaveBeenCalledOnce();
    });

    it('binds /exec to a process resource instead of direct tool invocation', async () => {
        const fixture = createFixture();
        const service = new PrivilegedCommandService(fixture.kernel, agentService());

        await service.exec({ sessionId: 'session-1', command: 'pnpm test' });

        expect(fixture.submit).toHaveBeenCalledWith(expect.objectContaining({
            program: { kind: 'kernel-adapters.exec', version: '1' },
            input: { command: 'pnpm test' },
            deferStart: true,
        }));
        expect(fixture.task.createResource).toHaveBeenCalledWith({
            requestId: 'capability:processHandleId', kind: 'process', uri: 'process://exec', rights: ['execute'],
        });
        expect(fixture.task.start).toHaveBeenCalledWith({
            signal: { type: 'capabilities', payload: { processHandleId: 'handle-1' } },
        });
    });
});

function createFixture() {
    const task = {
        id: 'task-1',
        createResource: vi.fn(async () => ({ handle: { id: 'handle-1' }, resource: {} })),
        signal: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
    } as unknown as TaskHandle;
    const submit = vi.fn(async () => task);
    const kernel = {
        openSession: vi.fn(async () => ({ submit })),
    } as unknown as Kernel;
    return { kernel, submit, task };
}

function agentService(): IAgentConfigService {
    return {
        getAgentConfig: vi.fn(async () => ({
            id: 'agent-1', version: 'v1', name: 'Agent', type: 'agent',
            config: {},
        })),
        getDefaultConnection: vi.fn(async () => ({
            id: 'connection-1', name: 'Connection', providerId: '', model: 'model-1',
            hasApiKey: true, enabled: true,
        })),
        getProvider: vi.fn(),
    } as unknown as IAgentConfigService;
}
