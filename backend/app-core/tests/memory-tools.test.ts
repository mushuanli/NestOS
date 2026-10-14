import { expect, it } from 'vitest';
import { bindCapabilities } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IDeviceDriver } from '@itookit/vfs-core';
import { SessionMemoryProvider } from '@itookit/llm-session';
import { createKernelRuntime } from '../src/runtime/create-kernel-runtime';

it('runs a model memory write through the shared Kernel tool Effect and returns its durable result', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const requests: any[] = [];
    const runtime = await createKernelRuntime({ systemFS: fs, recover: false,
        storageResolver: { kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) },
        llmDriver: { ioctl: async (_ctx: unknown, _code: unknown, request: any) => {
            requests.push(request);
            return { id: 'response', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0,
                message: requests.length === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function',
                    function: { name: 'memory_write', arguments: JSON.stringify({ scope: 'project', entryId: 'note', content: 'remembered' }) } }] }
                    : { role: 'assistant', content: 'done' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        } } as unknown as IDeviceDriver });
    try {
        const session = await runtime.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        const policy = { namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'] };
        const tools = runtime.toolCatalog.getToolDefinitions().filter(tool => tool.function?.name === 'memory_write');
        expect(tools).toHaveLength(1);
        const task = await session.submit({ program: { kind: 'llm.agent', version: '1' }, deferStart: true,
            input: { sessionId: 's', roundId: 'r', connectionId: 'default', messages: [{ role: 'user', content: 'remember' }],
                stream: false, tools, allowedToolIds: ['memory_write'], memoryPolicy: policy, approval: 'none' } });
        await bindCapabilities(task, [{ kind: 'llm', uri: 'llm://default', rights: ['execute', 'write'], signalKey: 'llmHandleId' },
            { kind: 'tool', uri: 'tool://session', rights: ['execute'], signalKey: 'toolHandleId' }]);
        const exit = await task.wait({ timeoutMs: 5000 }); expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(2); expect(JSON.stringify(requests[1].messages)).toContain('success');
        expect((await new SessionMemoryProvider(runtime.kernel).list('s', policy))[0].content).toBe('remembered');
        const bypass = await (await runtime.sessions.get('s')).toolService.invoke({ toolId: 'memory_write', args: {
            scope: 'project', entryId: 'note', content: 'bypass' } });
        expect(bypass.success).toBe(false);
        expect((await new SessionMemoryProvider(runtime.kernel).list('s', policy))[0].content).toBe('remembered');
    } finally { runtime.kernel.dispose(); await runtime.kernel.waitIdle(); await runtime.dispose(); await manager.dispose(); }
});
