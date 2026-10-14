import { expect, it, vi } from 'vitest';
import { bindCapabilities, type SessionHandle } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IDeviceDriver } from '@itookit/vfs-core';
import { createContextService, type ChatMessage } from '@itookit/llm-context';
import { createFileContextContentStore, createTaskContextStorage } from '@itookit/kernel-adapters';
import { createKernelRuntime, type HeadlessKernelRuntime } from '../src/runtime/create-kernel-runtime';

const definition = (name: string) => ({ type: 'function' as const, function: { name, description: name,
    parameters: { type: 'object', properties: {} } } });
const call = (name: string, args = {}) => ({ role: 'assistant', content: '', tool_calls: [
    { id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] });
const response = (message: unknown) => ({ id: 'response', object: 'chat.completion', created: 1, model: 'test',
    choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { total_tokens: 2 } });
async function close(runtime: HeadlessKernelRuntime) {
    runtime.kernel.dispose(); await runtime.kernel.waitIdle(); await runtime.dispose();
}

it('restores v2 at approval, preserves evidence, and commits checkpoint reset before the next request', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const requests: Array<{ messages: ChatMessage[] }> = [];
    const large = 'source evidence🙂'.repeat(12_000);
    const invoked: string[] = [];
    const make = () => createKernelRuntime({ systemFS: fs, recover: false,
        storageResolver: { kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) },
        configureSession: (_id, { toolDriver }) => {
            for (const id of ['read_evidence', 'write_result']) toolDriver.registerTool(
                { id, name: id, description: id, enabled: true, type: 'builtin', timeoutMs: 5000,
                    sideEffect: id === 'read_evidence' ? 'none' : 'external' },
                definition(id), async () => { invoked.push(id); return id === 'read_evidence' ? large : 'written'; });
        },
        llmDriver: { ioctl: async (_ctx: unknown, _code: unknown, request: { messages: ChatMessage[] }) => {
            requests.push(structuredClone(request));
            const messages = [call('read_evidence'), call('write_result'),
                call('context_checkpoint', { revision: 3, text: 'Evidence inspected and result written. Report completion.' }),
                { role: 'assistant', content: 'done' }];
            return response(messages[requests.length - 1]);
        } } as unknown as IDeviceDriver });
    let runtime = await make();
    try {
        let session: SessionHandle = await runtime.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        let task = await session.submit({ program: { kind: 'llm.agent', version: '2' }, deferStart: true,
            input: { sessionId: 's', roundId: 'r', connectionId: 'default', stream: false,
                messages: [{ role: 'system', content: 'Preserve policy' }, { role: 'user', content: 'Original goal' }],
                tools: [definition('read_evidence'), definition('write_result')], approval: 'external', externalToolIds: ['write_result'],
                contextCompaction: { maxMessages: 100, maxToolOutputBytes: 2048 } } });
        await bindCapabilities(task, [{ kind: 'llm', uri: 'llm://default', rights: ['execute', 'write'], signalKey: 'llmHandleId' },
            { kind: 'tool', uri: 'tool://session', rights: ['execute'], signalKey: 'toolHandleId' }]);
        await vi.waitFor(async () => expect((await task.status()).task.interactions['approval:2:write_result']?.status).toBe('pending'), { timeout: 5000 });
        expect(invoked).toEqual(['read_evidence']);
        const preview = requests[1].messages.find(message => message.role === 'tool')!.content as string;
        expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(2048);
        expect(preview).toContain('context_read');
        const id = task.id;
        const persisted = JSON.stringify((await task.status()).task.state);
        expect(persisted).not.toContain('Original goal');
        await close(runtime);
        runtime = await make();
        await runtime.kernel.recoverSession('s');
        session = await runtime.kernel.openSession('s'); task = await session.attachTask(id);
        await task.respond({ interactionId: 'approval:2:write_result', value: { approved: true } });
        const exit = await task.wait({ timeoutMs: 5000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(invoked).toEqual(['read_evidence', 'write_result']);
        expect(requests).toHaveLength(4);
        expect(JSON.stringify(requests[3].messages)).toContain('Evidence inspected and result written');
        expect(requests[3].messages[0].content).toBe('Preserve policy');
        const service = createContextService({ content: createFileContextContentStore(fs, `/session/tasks/${id}/context-content`),
            records: { get: async key => (await session.getShared(key))?.value } });
        expect((await service.inspect(id))?.generation).toBe(1);
        expect((await service.history(id, { query: 'Original goal' })).items).toHaveLength(1);
        expect((await service.history(id, { query: 'done' })).items).toHaveLength(1);
        const ref = JSON.parse(preview.match(/ref=(\{[^\n]+\})\]/)![1]);
        const original = await createFileContextContentStore(fs, `/session/tasks/${id}/context-content`).read(ref);
        expect(original.length).toBe(large.length);
        expect(original === large).toBe(true);
    } finally { await close(runtime); await manager.dispose(); }
});

it('runs v1 and v2 chat side by side and archives the final v2 assistant message', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const runtime = await createKernelRuntime({ systemFS: fs, recover: false,
        contextGc: { policy: { retentionMs: 0 } },
        storageResolver: { kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) },
        llmDriver: { ioctl: async () => response({ role: 'assistant', content: 'final answer' }) } as unknown as IDeviceDriver });
    try {
        const session = await runtime.kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        for (const version of ['1', '2']) {
            const task = await session.submit({ program: { kind: 'llm.chat', version }, deferStart: true,
                input: { sessionId: 's', roundId: 'r', connectionId: 'default', stream: false, messages: [{ role: 'user', content: 'Question' }] } });
            const content = createTaskContextStorage(fs, '/session', task.id).content;
            const orphan = version === '2' ? await content.publish('abandoned candidate', 'text/plain') : undefined;
            await bindCapabilities(task, [{ kind: 'llm', uri: 'llm://default', rights: ['execute', 'write'], signalKey: 'llmHandleId' }]);
            const exit = await task.wait({ timeoutMs: 5000 }); expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
            const entries = await session.listShared(`context/${task.id}/`);
            expect(entries.length).toBe(version === '1' ? 0 : 3);
            if (orphan) {
                const dry = await runtime.contextGc!.collect({ dryRun: true });
                expect(dry.find(result => result.taskId === task.id)).toMatchObject({ status: 'dry-run', candidates: 1, deleted: 0 });
                const collected = await runtime.contextGc!.collect();
                expect(collected.find(result => result.taskId === task.id)).toMatchObject({ status: 'collected', deleted: 1 });
                await expect(content.read(orphan)).rejects.toThrow('missing or corrupt');
                const reader = createContextService({ content, records: { get: async key => (await session.getShared(key))?.value } });
                expect((await reader.history(task.id, { query: 'final answer' })).items).toHaveLength(1);
            }
        }
    } finally { await close(runtime); await manager.dispose(); }
});
