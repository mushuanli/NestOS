import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createBuiltinDagPluginRegistry, DurableFlowExecutor, registerDurablePrograms, flowToDag } from '../src/flow';
import type { FlowRevision } from '../src/contracts';

let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
const createConsumer = vi.fn(() => ({ programKind: 'flow.value', programVersion: '1', input: {
    operation: 'transform', config: { value: 'RECOVERED' }, inputs: {}, dependencies: [],
} }));

beforeEach(async () => {
    createConsumer.mockClear();
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/data/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    kernel.registerProgram({ manifest: { kind: 'test.failure', version: '1' },
        init: () => ({ state: null, next: { type: 'fail', error: { code: 'INVALID_REQUEST', message: 'Provider rejected image input' } } }),
        reduce: () => { throw new Error('Unexpected reducer invocation'); } });
    await kernel.initialize(); await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    const plugins = createBuiltinDagPluginRegistry();
    for (const name of ['source', 'consumer']) plugins.register({ manifest: { id: `test.${name}`, version: '1', kind: name,
        title: name, category: 'Test', configSchema: { type: 'object' }, defaultConfig: {},
        inputs: [{ name: 'input', required: false, cardinality: 'one', order: 0 }], outputs: [{ name: 'result', required: true, order: 0 }] },
        runtime: async () => ({ createTask: name === 'consumer' ? createConsumer : () => ({ programKind: 'test.failure', programVersion: '1', input: null }) }) });
    executor = new DurableFlowExecutor({ kernel, plugins });
});
afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

it.each(['control', 'data'] as const)('preserves the original failure before rendering a required %s consumer', async kind => {
    const run = await executor.submit('s', await flowToDag(graph(kind, 'fail')));
    const exit = await run.root.wait({ timeoutMs: 3000 });
    expect(exit.status).toBe('failed');
    expect(exit.error).toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('Provider rejected image input') });
    expect(exit.error?.message).not.toContain('Missing Flow reference');
    expect(createConsumer).not.toHaveBeenCalled();
    expect((await run.nodes.get('consumer')?.status())?.task.status).toBe('failed');
});

it.each(['control', 'data'] as const)('cancels a skip-policy %s consumer without rendering its missing input', async kind => {
    const run = await executor.submit('s', await flowToDag(graph(kind, 'skip')));
    const exit = await run.root.wait({ timeoutMs: 3000 });
    expect(exit.error?.message).toContain('Provider rejected image input');
    expect(createConsumer).not.toHaveBeenCalled();
    expect((await run.nodes.get('consumer')?.status())?.task.status).toBe('cancelled');
});

it.each(['control', 'data'] as const)('allows an explicit continue-policy %s consumer to execute a fallback', async kind => {
    const run = await executor.submit('s', await flowToDag(graph(kind, 'continue')));
    expect((await run.root.wait({ timeoutMs: 3000 })).status).toBe('succeeded');
    expect(createConsumer).toHaveBeenCalledOnce();
    expect((await run.nodes.get('consumer')?.status())?.task.status).toBe('succeeded');
});

function graph(kind: 'control' | 'data', onFailure: 'fail' | 'skip' | 'continue'): FlowRevision {
    return { id: 'failure' as never, name: 'Failure', revision: 1, digest: 'failure', createdAt: 0,
        nodes: ['source', 'consumer'].map(id => ({ id: id as never, name: id, plugin: `test.${id}`, pluginVersion: '1', inputs: {},
            config: id === 'consumer' && onFailure !== 'continue' ? { value: '${nodes.source.outputs.result.cards}' } : {} })),
        edges: [{ id: 'dependency' as never, from: 'source' as never, to: 'consumer' as never, kind, input: 'input', output: 'result', onFailure }] };
}
