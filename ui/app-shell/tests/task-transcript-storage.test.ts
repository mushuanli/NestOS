// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Kernel, type DurableTaskProgram } from '@itookit/durable-kernel';
import { DagCommandService, createBuiltinDagPluginRegistry } from '../../../backend/llm-flow/src/index';
import { openTaskTranscript } from '../../llm-ui/src/components/dag/TaskTranscriptDialog';

it('exports all persisted exchanges through the command service after a Kernel reopen', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    const createKernel = () => {
        const host = new Kernel({ catalog: { fs }, pollMs: 1 });
        host.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session' }) });
        return host;
    };
    let kernel = createKernel();
    const ids = Array.from({ length: 101 }, (_, index) => `exchange-${String(index).padStart(3, '0')}`);
    const payload = 'x'.repeat(300_000);
    const program: DurableTaskProgram = {
        manifest: { kind: 'flow.aggregate', version: '1' },
        init: () => ({ state: null, actions: ids.map(id => ({ type: 'effect', effect: {
            id, kind: 'test.exchange', version: '1', request: id, idempotencyKey: id,
        } })), next: { type: 'wait', on: { type: 'all', waits: ids.map(id => ({ type: 'effect', id })) } } }),
        reduce: () => ({ state: null, next: { type: 'complete', output: 'complete' } }),
    };
    const NativeBlob = Blob; let exported = '';
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    vi.stubGlobal('Blob', class extends NativeBlob {
        constructor(parts: BlobPart[], options: BlobPropertyBag) { super(parts, options); exported = parts.join(''); }
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:transcript', revokeObjectURL: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
        kernel.registerProgram(program);
        kernel.registerEffect({ kind: 'test.exchange', version: '1', execute: async request => request === ids.at(-1) ? payload : request });
        await kernel.initialize();
        const session = await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
        const task = await session.submit({ program: program.manifest, input: { runTasks: [] }, labels: { kind: 'flow-root' } });
        expect((await task.wait({ timeoutMs: 10_000 })).status).toBe('succeeded');
        const version = (await task.status()).task.version;
        kernel.dispose(); await kernel.waitIdle(); kernel = createKernel(); await kernel.initialize();
        const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
        new DagCommandService({ kernel, plugins: createBuiltinDagPluginRegistry(), flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        const execute = vi.fn((name: string, args: unknown) => handlers.get(name)!(args));
        openTaskTranscript({ execute } as never, 'session', task.id, task.id);
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-export]')!.disabled).toBe(false));
        document.querySelector<HTMLButtonElement>('[data-export]')!.click();
        await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
        const result = JSON.parse(exported);
        expect(result.version).toBe(version); expect(result.effects.map((effect: any) => effect.effectId)).toEqual(ids);
        expect(result.effects.at(-1).result).toBe(payload); expect(result.output).toBe('complete');
        expect(execute.mock.calls).toHaveLength(3);
    } finally {
        document.body.replaceChildren(); kernel.dispose(); await kernel.waitIdle(); await manager.dispose();
        vi.restoreAllMocks(); vi.unstubAllGlobals();
        if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
}, 20_000);
