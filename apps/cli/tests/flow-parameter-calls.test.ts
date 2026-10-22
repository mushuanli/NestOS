import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runCommand, respondCommand, resumeCommand, validateCommand } from '../src/commands';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'flow-parameter-calls-'));
    cleanup.push(root);
    for (const name of ['parameter-record', 'parameter-calls']) {
        await copyFile(fileURLToPath(new URL(`../examples/${name}.flow`, import.meta.url)), path.join(root, `${name}.flow`));
    }
    const options = { file: path.join(root, 'parameter-calls.flow'), profile: root,
        stateDir: path.join(root, 'state'), headless: true, json: true };
    const manifest = async () => {
        const [id] = await readdir(path.join(options.stateDir, 'runs'));
        return JSON.parse(await readFile(path.join(options.stateDir, 'runs', id, 'run.json'), 'utf8'));
    };
    return { root, options, manifest };
}

it('calls a sibling Flow with multiple named arguments and preserves input order', async () => {
    const { options, manifest } = await setup();
    expect(await validateCommand(options)).toBe(0);
    expect(await runCommand(options)).toBe(0);
    const saved = await manifest();
    const result = JSON.parse(await readFile(path.join(options.stateDir, 'runs', saved.id, 'result.json'), 'utf8'));
    expect(result).toEqual({ results: [
        { result: { source: 'first document', language: 'zh-CN', detail: 2 } },
        { result: { source: 'second document', language: 'en', detail: 2 } },
    ] });
    const taskIds = saved.nodeTaskIds;
    expect(await resumeCommand(saved.id, options)).toBe(0);
    expect((await manifest()).nodeTaskIds).toEqual(taskIds);
});

it('resumes serial argument calls from a frozen child definition without repeating completed calls', async () => {
    const { root, options, manifest } = await setup();
    const file = path.join(root, 'parameter-record.flow');
    const child = JSON.parse(await readFile(file, 'utf8'));
    child.nodes.unshift({ id: 'review', name: 'Review ${param.source}', plugin: 'builtin.human', pluginVersion: '1.0.0',
        inputs: {}, config: { requestId: 'confirm', prompt: 'Review ${param.source}' } });
    child.edges.push({ id: 'review-record', from: 'review', to: 'record', kind: 'control' });
    await writeFile(file, JSON.stringify(child));
    expect(await runCommand(options)).toBe(3);
    const first = await manifest();
    expect(first.pendingInteractions).toHaveLength(1);
    expect(JSON.stringify(first.pendingInteractions[0])).toContain('first document');
    await writeFile(file, JSON.stringify({ ...child, outputs: { result: { value: 'changed after submission' } } }));
    expect(await respondCommand(first.id, first.pendingInteractions[0].interactionId, { ...options, value: 'approved' })).toBe(0);
    expect(await resumeCommand(first.id, options)).toBe(3);
    const second = await manifest();
    expect(second.pendingInteractions).toHaveLength(1);
    expect(JSON.stringify(second.pendingInteractions[0])).toContain('second document');
    expect(await respondCommand(second.id, second.pendingInteractions[0].interactionId, { ...options, value: 'approved' })).toBe(0);
    expect(await resumeCommand(second.id, options)).toBe(0);
    const result = JSON.parse(await readFile(path.join(options.stateDir, 'runs', first.id, 'result.json'), 'utf8'));
    expect(result.results.map((value: { result: { source: string } }) => value.result.source)).toEqual(['first document', 'second document']);
    const final = await manifest();
    for (const [id, taskId] of Object.entries(first.nodeTaskIds)) expect(final.nodeTaskIds[id]).toBe(taskId);
}, 30_000);

it.each(['combined', 'grouped'])('runs one self-contained Flow over mixed text and image batches (%s)', async mode => {
    const { root, options, manifest } = await setup();
    const file = path.join(root, 'single.flow');
    await copyFile(fileURLToPath(new URL('../examples/parameter-batches.flow', import.meta.url)), file);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6kAAAAASUVORK5CYII=';
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } };
    const content = [{ type: 'text', text: 'Keep ${param.literal} as data' }, image, image,
        { type: 'text', text: 'second document' }, { type: 'text', text: 'last document' }];
    if (mode === 'grouped') {
        const flow = JSON.parse(await readFile(file, 'utf8'));
        flow.parameters = flow.parameters.filter((field: { name: string }) => field.name !== 'content');
        flow.parameters.push({ name: 'groups', type: 'json', required: true });
        delete flow.nodes[0].config.value;
        Object.assign(flow.nodes[0].config, { groups: '${param.groups}', mode: 'grouped' });
        await writeFile(file, JSON.stringify(flow));
    }
    const paramsFile = path.join(root, 'batch-input.json');
    const input = mode === 'grouped' ? { groups: [content.slice(0, 3), content.slice(3)] } : { content };
    await writeFile(paramsFile, JSON.stringify({ ...input, batchSize: 2 }));
    await rm(path.join(root, 'parameter-record.flow'));
    await rm(path.join(root, 'parameter-calls.flow'));
    expect(await validateCommand({ ...options, file })).toBe(0);
    expect(await runCommand({ ...options, file, paramsFile })).toBe(0);
    const saved = await manifest();
    const result = JSON.parse(await readFile(path.join(options.stateDir, 'runs', saved.id, 'result.json'), 'utf8'));
    expect(result.results.map((row: any) => row.result.content.length)).toEqual(mode === 'grouped' ? [2, 1, 2] : [2, 2, 1]);
    expect(result.results.map((row: any) => row.result.language)).toEqual(['zh-CN', 'zh-CN', 'zh-CN']);
    const parts = result.results.flatMap((row: any) => row.result.content);
    expect(parts.map((part: any) => part.type)).toEqual(['text', 'image', 'image', 'text', 'text']);
    expect(parts[0].text).toBe('Keep ${param.literal} as data');
    expect(parts.filter((part: any) => part.type === 'image').every((part: any) =>
        part.source.type === 'asset' && part.source.asset.kind === 'input' && part.source.asset.mimeType === 'image/png')).toBe(true);
    expect((await readdir(root)).filter(name => name.endsWith('.flow'))).toEqual(['single.flow']);
});
