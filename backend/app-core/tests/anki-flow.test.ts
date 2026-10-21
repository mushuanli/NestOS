import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel, type EffectAdapter } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { ToolProgram } from '@itookit/kernel-adapters';
import {
    createBuiltinDagPluginRegistry, createFlowRevision, DurableFlowExecutor,
    flowToDag, registerDurablePrograms, validateFlowRevision,
} from '@itookit/llm-flow';
import { createMindosFlowLibrary } from '../src/presets/flow-library';

const draft = (id = 'anki-generate') => createMindosFlowLibrary().find(flow => flow.id === id)!;
const card = { name: 'apple', unit: 2, symbol: '/ˈæpəl/', chn: '苹果', example_en: 'I eat an apple.',
    example_cn: '我吃一个苹果。', word_family: 'apples', memory_tips: '联想苹果的形状。', difficulty: '1',
    collocations: 'an apple a day 每天一个苹果', image_prompt: 'A student eating a red apple.' };
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
let responses: string[], requests: Record<string, unknown>[], toolRequests: Record<string, unknown>[];

beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    kernel.registerProgram(new ToolProgram());
    responses = []; requests = []; toolRequests = [];
    kernel.registerEffect({ kind: 'tool.call', version: '1', async execute(request: Record<string, unknown>) {
        toolRequests.push(request);
        if (request.toolId === 'image.process') return {toolId:'image.process',success:true,data:{images:(request.args as {images:unknown}).images},output:'',durationMs:0};
        if (request.toolId === 'anki.prepare') {
            const source = (request.args as { source: unknown }).source;
            return { toolId: 'anki.prepare', success: true, data: { cards: Array.isArray(source) ? source : [{ name: 'apple', unit: 2 }] }, output: '', durationMs: 0 };
        }
        return { toolId: 'anki.plan', success: true, data: { artifacts: { manifest: { path: 'output/anki.manifest.yaml', mimeType: 'application/yaml' }, package: { path: 'output/deck.apkg', mimeType: 'application/octet-stream' } }, spawn: { idempotencyKey: 'package-test',
            nodes: [{ id: 'package', name: 'Package fixture', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'PACKED' } }],
            edges: [{ id: 'spawn-package', from: '$parent', to: 'package', kind: 'control' }] } }, output: '', durationMs: 0 };
    } } as EffectAdapter);
    kernel.registerEffect({ kind: 'llm.chat', version: '1', async execute(request: Record<string, unknown>) {
        requests.push(request);
        return { choices: [{ index: 0, message: { role: 'assistant', content: responses.shift() ?? '{}' }, finish_reason: 'stop' }] };
    } } as EffectAdapter);
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), resolveTools: async (_session, ids) => ({
        definitions: ids.map(name => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } })), externalIds: [],
    }) });
    await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
});

afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

async function submit(parameters: Record<string, any> = {}, id = 'anki-generate') {
    const spec = await flowToDag(createFlowRevision(draft(id), 1), undefined, undefined,
        async id => createFlowRevision(draft(id), 1), [], undefined, false, undefined, undefined,
        async (flow, bindings) => ({ ...flow, connections: flow.connections?.map(slot => ({ ...slot,
            connectionId: bindings?.[slot.name] || (slot.required === false ? undefined : `test-${slot.name}`) })) }));
    return executor.submit('s', spec, parameters);
}

it('exports the same standalone definition as the recoverable catalog and validates its graph', () => {
    for (const id of ['anki-build', 'anki-generate', 'anki-from-image']) {
        const local = draft(id);
        expect(JSON.parse(readFileSync(new URL(`../../../apps/cli/examples/${id}.flow`, import.meta.url), 'utf8'))).toEqual(local);
        expect(JSON.parse(readFileSync(new URL(`../../../tools/anki-cli/flows/${id}.flow`, import.meta.url), 'utf8'))).toEqual(local);
        expect(validateFlowRevision(createFlowRevision(local, 1), createBuiltinDagPluginRegistry())).toEqual([]);
    }
    const exported = JSON.parse(readFileSync(new URL('../../../apps/cli/examples/anki-generate.flow', import.meta.url), 'utf8'));
    expect(exported).toEqual(draft());
    expect(JSON.parse(readFileSync(new URL('../../../tools/anki-cli/flows/anki-generate.flow', import.meta.url), 'utf8'))).toEqual(exported);
    expect(validateFlowRevision(createFlowRevision(draft(), 1), createBuiltinDagPluginRegistry())).toEqual([]);
    const edited = draft(); edited.nodes[0].name = 'User edit';
    expect(draft().nodes[0].name).not.toBe('User edit');
});

it('collects missing words, repairs model output and sends complete cards to the external planning tool', async () => {
    responses = ['{"cards":[{"name":"apple"}]}', JSON.stringify({ cards: [card] })];
    const run = await submit({ requirements: '保留我的例句 ${param.secret}' });
    await vi.waitFor(() => expect(run.nodes.has('collect')).toBe(true));
    const input = run.nodes.get('collect')!;
    await vi.waitFor(async () => expect((await input.status()).task.interactions['input-1']).toBeDefined());
    expect(requests).toHaveLength(0);
    await input.respond({ interactionId: 'input-1', value: { words: 'Unit 2\napple' } });
    const exit = await run.root.wait({ timeoutMs: 6000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(2);
    const requestText = JSON.stringify(requests[0]);
    expect(requestText).toContain('apple');
    expect(requestText).toContain('保留我的例句 ${param.secret}');
    expect(requestText).toContain('test-text');
    expect(toolRequests).toHaveLength(3);
    expect((toolRequests[2].args as { cards: unknown }).cards).toEqual({ cards: [card] });
    expect((await run.nodes.get('build/package')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'PACKED' } } });
});

it('fails after exhausted schema repairs without publishing invalid cards', async () => {
    responses = Array(3).fill('{"cards":[{"name":"apple","audio":"invented.mp3"}]}');
    const run = await submit({ words: JSON.stringify([{ name: 'apple', unit: 2, chn: '苹果' }]) });
    expect((await run.root.wait({ timeoutMs: 6000 })).status).toBe('failed');
    expect(requests).toHaveLength(3);
    expect(toolRequests.map(request => request.toolId)).toEqual(['anki.prepare', 'anki.prepare']);
});

it('transcribes image inputs, waits for explicit correction and sends only corrected cards to the shared Flow', async () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    responses = [JSON.stringify({ cards: [{ name: 'apple', unit: 2, symbol: '', chn: '苹果?' }] }), JSON.stringify({ cards: [card] })];
    const run = await submit({ images: [{ type: 'image_url', image_url: { url: image } }] }, 'anki-from-image');
    await vi.waitFor(async () => expect((await run.nodes.get('review')?.status())?.task.interactions['input-1']).toBeDefined());
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(image);
    expect(JSON.stringify(requests[0])).toContain('test-vision');
    expect(toolRequests).toHaveLength(1);
    expect(toolRequests[0]).toMatchObject({toolId:'image.process',args:{recipe:{color:'grayscale',resize:{maxEdge:2048}}}});
    const review = run.nodes.get('review')!;
    const interaction = (await review.status()).task.interactions['input-1'];
    expect(interaction.payload).toMatchObject({ values: { cards: [{ chn: '苹果?' }] } });
    await review.respond({ interactionId: 'input-1', value: { cards: [{ name: 'apple', unit: 2, symbol: '/a/', chn: '青苹果' }] } });
    const exit = await run.root.wait({ timeoutMs: 6000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('青苹果');
    expect(JSON.stringify(requests[1])).not.toContain(image);
    expect(toolRequests.at(-1)?.args).toMatchObject({ source: [{ chn: '青苹果', symbol: '/a/' }] });
});

it('requests replacement images for unsupported image data before invoking a model', async () => {
    const run = await submit({ images: ['file:///etc/private.png'] }, 'anki-from-image');
    await vi.waitFor(async () => expect((await run.nodes.get('collect')?.status())?.task.interactions['input-1']).toBeDefined());
    expect(requests).toHaveLength(0);
    await run.root.cancel();
});
