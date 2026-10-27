import {access, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {runCommand} from '../src/commands';
import {loadFlowDefinition} from '../src/flow-config';

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-flow-exposure-')); roots.push(root);
    const child = {id: 'child', name: 'Local implementation', draftVersion: 1, exposure: 'local', updatedAt: 1,
        nodes: [{id: 'out', name: 'Out', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'internal-result'}}],
        edges: [], layout: {}, outputs: {result: {value: '${nodes.out.outputs.result}'}}};
    const file = path.join(root, 'child.flow'); await writeFile(file, JSON.stringify(child));
    return {root, file, options: {profile: root, stateDir: path.join(root, 'state'), headless: true, json: true}};
}

it('rejects a local root before loading parameters or creating execution storage', async () => {
    const f = await fixture();
    await expect(runCommand({...f.options, file: f.file, paramsFile: path.join(f.root, 'missing.json')}))
        .rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    await expect(access(f.options.stateDir)).rejects.toMatchObject({code: 'ENOENT'});
    expect((await loadFlowDefinition(f.file)).exposure).toBe('local');
});

it.each(['global', undefined])('allows a %s root to call a local sibling and freeze its compiled result', async exposure => {
    const f = await fixture(), file = path.join(f.root, 'parent.flow');
    await writeFile(file, JSON.stringify({id: 'parent', name: 'Parent', draftVersion: 1, exposure, updatedAt: 1, edges: [], layout: {},
        nodes: [{id: 'invoke', name: 'Invoke', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: {flowId: 'child'}}],
        outputs: {result: {value: '${nodes.invoke.outputs.result}'}}}));
    expect(await runCommand({...f.options, file})).toBe(0);
    const runs = await readdir(path.join(f.options.stateDir, 'runs')); expect(runs).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(f.options.stateDir, 'runs', runs[0], 'result.json'), 'utf8'))).toEqual({result: 'internal-result'});
});
