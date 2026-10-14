/**
 * P0-02：宿主在「等待人工批准」时消失后重开，必须重新挂接该运行。
 *
 * 运行中等待交互的 Task 不会在重开时被任何事件重新驱动；不重新挂接就没有提示、
 * `/approve` 也无处可发，会话既不能继续也不能发送新消息。用真实 Kernel 验证选择与挂接。
 */
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Kernel, type DurableTaskProgram, type TaskRecord } from '@itookit/durable-kernel';
import { RunAttachmentController } from '../../llm-ui/src/shell/RunAttachmentController';
import { pendingInteractionTask, restoreWaitingAttachment } from '../../llm-ui/src/shell/pending-interaction';

const spec = { program: { kind: 'test.wait', version: '1' }, input: null };

function waitProgram(): DurableTaskProgram<null, null, string> {
    return {
        manifest: { kind: 'test.wait', version: '1' },
        init: () => ({ state: null, actions: [{ type: 'request-interaction', interaction: { id: 'answer', kind: 'approval', prompt: 'Approve?' } }],
            next: { type: 'wait', on: { type: 'interaction', id: 'answer' } } }),
        reduce: () => ({ state: null, next: { type: 'complete', output: 'done' } }),
    };
}

async function fixture() {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/data');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session' }; } });
    kernel.registerProgram(waitProgram());
    await kernel.initialize();
    const session = await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
    return { kernel, session, fs, backend, async dispose() { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); } };
}

it('re-attaches the non-terminal Task that is waiting for an approval', async () => {
    const f = await fixture();
    try {
        const waiting = await f.session.submit(spec);
        await vi.waitFor(async () => expect((await waiting.status()).task.interactions?.answer?.status).toBe('pending'));

        const attach = vi.fn(async () => {});
        expect(await restoreWaitingAttachment(f.kernel, 'session', attach)).toBe(waiting.id);
        expect(attach).toHaveBeenCalledWith(waiting.id);
    } finally { await f.dispose(); }
});

it('attaches nothing when no run is waiting', async () => {
    const f = await fixture();
    try {
        const tasks = await f.kernel.listSessionTasks('session');
        expect(pendingInteractionTask(tasks)).toBeUndefined();
        const attach = vi.fn(async () => {});
        expect(await restoreWaitingAttachment(f.kernel, 'session', attach)).toBeUndefined();
        expect(attach).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
});

it('uses the durable status index without reading completed Task bodies or enumerating directories', async () => {
    const f = await fixture();
    try {
        const finished = await f.session.submit(spec);
        await vi.waitFor(async () => expect((await finished.status()).task.interactions?.answer?.status).toBe('pending'));
        await finished.respond({ interactionId: 'answer', value: true });
        await finished.wait({ timeoutMs: 2000 });
        const waiting = await f.session.submit(spec);
        await vi.waitFor(async () => expect((await waiting.status()).task.interactions?.answer?.status).toBe('pending'));
        await f.kernel.waitIdle();
        const fullScan = vi.spyOn(f.kernel, 'listSessionTasks');
        const directories = vi.spyOn(f.fs.driver, 'getChildren');
        const reads = vi.spyOn(f.backend.records!, 'getRecordField');
        try {
            expect(await restoreWaitingAttachment(f.kernel, 'session', async () => {})).toBe(waiting.id);
            expect(fullScan).not.toHaveBeenCalled();
            expect(directories).not.toHaveBeenCalled();
            expect(reads.mock.calls.some(([path]) => path.includes(finished.id))).toBe(false);
            expect(reads.mock.calls.some(([path]) => path.includes(waiting.id))).toBe(true);
            expect(await restoreWaitingAttachment(f.kernel, 'session', async () => {}, () => true, new Set([waiting.id]))).toBeUndefined();
        } finally { reads.mockRestore(); directories.mockRestore(); fullScan.mockRestore(); }
    } finally { await f.dispose(); }
});

it('prefers the most recently updated waiting run', () => {
    const task = (id: string, updatedAt: number, status: TaskRecord['status'], interactionStatus: string): TaskRecord => ({
        id, sessionId: 'session', program: { kind: 'test', version: '1' }, status, version: 1, createdAt: 1, updatedAt,
        input: null, output: null, effects: {}, pendingEvents: [], attempts: [], interactions: {
            answer: { id: 'answer', kind: 'approval', prompt: 'Approve?', status: interactionStatus, requestedAt: 1 },
        },
    } as unknown as TaskRecord);

    expect(pendingInteractionTask([
        task('old', 10, 'waiting', 'pending'),
        task('resolved', 30, 'waiting', 'resolved'),
        task('done', 40, 'succeeded', 'pending'),
        task('new', 20, 'running', 'pending'),
    ])?.id).toBe('new');
});

it('discards a pending lookup after its view becomes obsolete', async () => {
    const f = await fixture();
    try {
        const waiting = await f.session.submit(spec);
        await vi.waitFor(async () => expect((await waiting.status()).task.interactions?.answer?.status).toBe('pending'));
        const tasks = await f.kernel.listSessionTasks('session');
        let resolve!: (value: TaskRecord[]) => void;
        const kernel = { listSessionTasks: vi.fn(() => new Promise<TaskRecord[]>(done => { resolve = done; })) };
        let current = true;
        const attach = vi.fn(async () => {});
        const restoring = restoreWaitingAttachment(kernel, 'session', attach, () => current);
        current = false; resolve(tasks);
        expect(await restoring).toBeUndefined();
        expect(attach).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
});

it('restores a pending approval after Kernel reconstruction and completes the original task', async () => {
    const f = await fixture();
    let restored: Kernel | undefined;
    let controller: RunAttachmentController | undefined;
    try {
        const task = await f.session.submit(spec);
        await vi.waitFor(async () => expect((await task.status()).task.interactions.answer.status).toBe('pending'));
        f.kernel.dispose(); await f.kernel.waitIdle();
        restored = new Kernel({ catalog: { fs: f.fs }, pollMs: 1 });
        restored.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs: f.fs, rootPath: '/session' }) });
        restored.registerProgram(waitProgram()); await restored.initialize();
        const onWaiting = vi.fn();
        controller = new RunAttachmentController(restored, { onEvent: () => {}, onWaiting });
        expect(await restoreWaitingAttachment(restored, 'session', id => controller!.attach(id))).toBe(task.id);
        await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledWith(expect.objectContaining({ id: 'answer' })));
        await controller.approve();
        expect((await (await restored.openTask(task.id)).wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        expect((await restored.listSessionTasks('session')).map(item => item.id)).toEqual([task.id]);
    } finally {
        await controller?.detach(); restored?.dispose(); await restored?.waitIdle(); await f.dispose();
    }
});
