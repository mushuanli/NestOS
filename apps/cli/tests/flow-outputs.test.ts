import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';

it('publishes declared Flow outputs instead of selecting the last authored node', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'flow-outputs-'));
    try {
        const file = path.join(root, 'outputs.flow');
        await writeFile(file, JSON.stringify({ id: 'outputs', name: 'Outputs', draftVersion: 1, updatedAt: 0, edges: [],
            nodes: [{ id: 'source', name: 'Source', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'report.yaml' } },
                { id: 'last', name: 'Last', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'OTHER' } }],
            outputs: { file: { value: '${nodes.source.outputs.result}', schema: { type: 'string' } }, count: { value: 2, schema: { type: 'number' } } },
        }));
        expect(await runCommand({ file, profile: root, stateDir: root, headless: true, json: true })).toBe(0);
        const [id] = await readdir(path.join(root, 'runs'));
        expect(JSON.parse(await readFile(path.join(root, 'runs', id, 'result.json'), 'utf8'))).toEqual({ file: 'report.yaml', count: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('loads sibling child definitions and preserves named returns in the compiled run snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'flow-siblings-'));
    try {
        const file = path.join(root, 'parent.flow');
        await writeFile(path.join(root, 'child.flow'), JSON.stringify({ id: 'child', name: 'Child', draftVersion: 1, updatedAt: 0,
            parameters: [{ name: 'text', type: 'string', required: true }], edges: [],
            nodes: [{ id: 'echo', name: 'Echo', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${param.text}' } }],
            outputs: { result: { value: '${nodes.echo.outputs.result}' } } }));
        await writeFile(file, JSON.stringify({ id: 'parent', name: 'Parent', draftVersion: 1, updatedAt: 0, edges: [],
            nodes: [{ id: 'call', name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
                config: { flowId: 'child', parameters: { text: 'sibling result' } } }], outputs: { result: { value: '${nodes.call.outputs.result}' } } }));
        expect(await runCommand({ file, profile: root, stateDir: root, headless: true, json: true })).toBe(0);
        const [id] = await readdir(path.join(root, 'runs'));
        expect(JSON.parse(await readFile(path.join(root, 'runs', id, 'result.json'), 'utf8'))).toEqual({ result: 'sibling result' });
        const { siblingFlowResolver } = await import('../src/flow-config');
        await expect(siblingFlowResolver(file)('../private')).rejects.toThrow('Invalid sibling');
        await expect(siblingFlowResolver(file)('child', 9)).rejects.toThrow('mismatch');
    } finally { await rm(root, { recursive: true, force: true }); }
});
