import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCommand, respondCommand, resumeCommand, rerunCommand } from '../src/commands';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('runs a .flow draft through RunDefinition without YAML environment', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mindos-flow-run-'));
    cleanup.push(root);
    const flowPath = path.join(root, 'demo.flow');
    await writeFile(flowPath, JSON.stringify({
        id: 'demo', draftVersion: 1, name: 'Demo',
        nodes: [{
            id: 'out', name: 'Out', plugin: 'builtin.transform', pluginVersion: '1.0.0',
            config: { operation: 'identity', outputName: 'result', type: 'text' },
            inputs: { input: 'hello' }, capabilities: [],
        }],
        edges: [], layout: {}, parameters: [], connections: [], updatedAt: 1,
    }), 'utf8');
    const code = await runCommand({ file: flowPath, profile: root, stateDir: path.join(root, 'state'), headless: true, json: true });
    expect(code).toBe(0);
    const runs = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, 'state', 'runs')));
    expect(runs).toHaveLength(1);
    expect(await readFile(path.join(root, 'state', 'runs', runs[0], 'result.txt'), 'utf8')).toContain('hello');
    expect(await rerunCommand(runs[0], { profile: root, stateDir: path.join(root, 'state'), json: true })).toBe(0);
});

it('rejects non-object parameter files before starting a run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mindos-flow-invalid-'));
    cleanup.push(root);
    const paramsFile = path.join(root, 'params.json');
    await writeFile(paramsFile, '[]');
    const file = path.join(root, 'host-template.flow');
    await copyFile(path.resolve('../../backend/app-core/src/presets/essay-review-isolated.json'), file);
    await expect(runCommand({ file, paramsFile, profile: root })).rejects.toThrow('JSON object');
});

it('loads parameter files and resumes a missing field through the saved flow definition', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mindos-flow-input-'));
    cleanup.push(root);
    const file = path.join(root, 'input.flow');
    const paramsFile = path.join(root, 'params.json');
    await writeFile(paramsFile, JSON.stringify({ requirements: 'keep ${param.literal} verbatim' }));
    await writeFile(file, JSON.stringify({
        id: 'input', draftVersion: 1, name: 'Input', updatedAt: 1,
        parameters: [{ name: 'requirements', type: 'string', onMissing: 'interact' }, { name: 'essay', type: 'string', onMissing: 'interact' }],
        nodes: [
            { id: 'collect', name: 'Collect', plugin: 'builtin.input', pluginVersion: '1.0.0', inputs: {},
                config: { param: { requirements: { type: 'string', nonBlank: true }, essay: { type: 'string', nonBlank: true } } } },
            { id: 'out', name: 'Out', plugin: 'builtin.transform', pluginVersion: '1.0.0',
                inputs: { input: '${param.essay}' }, config: { operation: 'identity', type: 'text' } },
        ], edges: [],
    }));
    const options = { file, paramsFile, profile: root, stateDir: path.join(root, 'state'), headless: true, json: true };
    expect(await runCommand(options)).toBe(3);
    const { RunStore } = await import('../src/run-store');
    const store = new RunStore(options.stateDir);
    const [run] = await store.list();
    expect(run.pendingInteractions).toHaveLength(1);
    expect(JSON.stringify(run.pendingInteractions[0])).toContain('essay');
    expect(await respondCommand(run.id, run.pendingInteractions[0].interactionId, { ...options, value: JSON.stringify({ essay: 'finished' }) })).toBe(0);
    expect(await resumeCommand(run.id, options)).toBe(0);
    expect(await readFile(path.join(store.runDir(run.id), 'result.txt'), 'utf8')).toBe('finished');
});
