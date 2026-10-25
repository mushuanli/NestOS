import { readFileSync } from 'node:fs';
import { DagCommandService } from '../src/flow/commands';
import { FlowCommand } from '../src/flow/command-names';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';
import { describe, expect, it, vi } from 'vitest';
import type { FlowDraft, FlowRevision } from '../src/contracts';
import type { FlowStore } from '../src/flow-definition-store';
import { createFlowRevision, FlowDefinitionStore, generateFlowId } from '../src/flow-definition-store';
import { flowRevisionToDraft } from '../src/flow/definition-projection';
import { flowRevisionDigest } from '../src/flow/validation';
import { flowToDag } from '../src/flow/to-dag';

interface MemoryFile { nodeId: string; name: string; content: string; }

function memoryStore(): FlowStore {
    const files = new Map<string, MemoryFile>();
    const assets = new Map<string, Map<string, string>>();
    return {
        listFiles: async () => [...files.values()].map(file => ({ nodeId: file.nodeId, name: file.name })),
        findFile: async name => {
            const file = [...files.values()].find(item => item.name === name);
            return file ? { nodeId: file.nodeId, name: file.name } : null;
        },
        createFile: async (name, content) => {
            const nodeId = `/${name}`;
            files.set(nodeId, { nodeId, name, content });
            return { nodeId, name };
        },
        readFile: async nodeId => files.get(nodeId)?.content ?? null,
        writeFile: async (nodeId, content) => {
            const file = files.get(nodeId);
            if (file) file.content = content;
        },
        renameFile: async (nodeId, newName) => {
            const file = files.get(nodeId);
            if (!file) return;
            files.delete(nodeId);
            file.nodeId = `/${newName}`;
            file.name = newName;
            files.set(file.nodeId, file);
        },
        deleteFile: async nodeId => { files.delete(nodeId); },
        createAsset: async (nodeId, filename, content) => {
            if (!assets.has(nodeId)) assets.set(nodeId, new Map());
            assets.get(nodeId)!.set(filename, typeof content === 'string' ? content : new TextDecoder().decode(content));
            return filename;
        },
        readAsset: async (nodeId, filename) => assets.get(nodeId)?.get(filename) ?? null,
        listAssets: async nodeId => [...(assets.get(nodeId)?.keys() ?? [])].map(name => ({ name, path: name })),
    };
}

function revision(number: number, name: string): FlowRevision {
    const withoutDigest = {
        id: 'flow' as FlowRevision['id'],
        revision: number,
        name,
        nodes: [],
        edges: [],
        createdAt: Date.now(),
    };
    return { ...withoutDigest, digest: flowRevisionDigest(withoutDigest) } as FlowRevision;
}

describe('FlowDefinitionStore', () => {
    it('preserves call scope through draft save, immutable publication and archive projection', async () => {
        const store = new FlowDefinitionStore(memoryStore());
        const draft = await store.createDraft({id: 'private', name: 'Private'});
        const saved = await store.saveDraft({...draft, exposure: 'local'}, draft.draftVersion);
        const published = await store.createRevision(saved);
        expect(await store.loadDraft('private')).toMatchObject({exposure: 'local'});
        expect(await store.loadRevision('private', published.revision)).toMatchObject({exposure: 'local', digest: published.digest});
        expect(flowRevisionToDraft(published).exposure).toBe('local');
        await store.saveDraft({...saved, exposure: 'global'}, saved.draftVersion);
        expect((await store.loadRevision('private', published.revision))?.exposure).toBe('local');
        await expect(store.saveRevision({...published, revision: 2, exposure: 'unknown'} as never)).rejects.toThrow('Exposure must be global or local');
    });
    it('keeps nested authored definitions through adoption, publication and archive projection', async () => {
        const storage = memoryStore(), store = new FlowDefinitionStore(storage);
        const child: FlowDraft = { id: 'helper' as never, name: 'Helper', nodes: [], edges: [], layout: {},
            parameters: [{ name: 'value', type: 'string' }], draftVersion: 1, updatedAt: 0 };
        const original = { ...child, id: '' as never, functions: [{ ...child, functions: [child] }],
            variables: { count: { type: 'number' as const, initial: 2 } }, outputs: { result: { value: 'literal' } },
            defaults: { stream: false }, runPolicy: { maxNodes: 20 } };
        const file = await storage.createFile('template.flow', JSON.stringify(original));
        const adopted = await store.adoptDraft(file.nodeId, 'Adopted');
        expect(adopted.functions).toEqual(original.functions);
        const published = createFlowRevision(adopted, 3, 100);
        const projected = flowRevisionToDraft(published);
        expect(projected.functions?.[0].functions?.[0]).toMatchObject({ id: 'helper', draftVersion: 3 });
        expect(projected).toMatchObject({ variables: original.variables, outputs: original.outputs,
            defaults: original.defaults, runPolicy: original.runPolicy });
        adopted.functions![0].name = 'Changed';
        expect(published.functions![0].name).toBe('Helper');
    });
    it('creates, lists and saves drafts with engine-owned optimistic versions', async () => {
        const store = new FlowDefinitionStore(memoryStore());
        const created = await store.createDraft({ id: 'draft', name: 'Draft' });
        expect(created.draftVersion).toBe(1);
        await expect(store.listDrafts()).resolves.toMatchObject([{ id: 'draft', name: 'Draft' }]);

        const saved = await store.saveDraft({ ...created, name: 'Changed' }, 1);
        expect(saved).toMatchObject({ name: 'Changed', draftVersion: 2 });
        await expect(store.saveDraft({ ...saved, name: 'Stale' }, 1))
            .rejects.toThrow(/version conflict/);
        await expect(store.loadDraft('draft')).resolves.toMatchObject({
            name: 'Changed',
            draftVersion: 2,
        });
        await expect(store.createDraft({ id: '../escape', name: 'Unsafe' }))
            .rejects.toThrow(/Flow ID/);
    });

    it('publishes immutable revisions from a matching draft snapshot', async () => {
        const store = new FlowDefinitionStore(memoryStore());
        const draft = await store.createDraft({ id: 'published', name: 'Published' });
        const first = await store.createRevision(draft);
        const changed: FlowDraft = { ...draft, draftVersion: 2, name: 'Published v2' };
        const second = await store.createRevision(changed);
        expect(first.revision).toBe(1);
        expect(second.revision).toBe(2);
        await expect(store.loadRevision('published', 1)).resolves.toMatchObject({
            name: 'Published',
        });
    });

    it('loads immutable v3 revisions and the latest pointer', async () => {
        const store = new FlowDefinitionStore(memoryStore());
        await store.createDraft({ id: 'flow', name: 'Flow' });
        const first = revision(1, 'v1');
        const second = revision(2, 'v2');
        await store.saveRevision(first);
        await store.saveRevision(second);
        await expect(store.loadRevision('flow', 1)).resolves.toMatchObject({ name: 'v1' });
        await expect(store.loadRevision('flow')).resolves.toMatchObject({ name: 'v2' });
        await expect(store.saveRevision({ ...second, name: 'changed' })).rejects.toThrow(/digest mismatch|immutable/);
    });
});

describe('builtin Flow installation receipts', () => {
    it('does not resurrect a deleted template after the store is recreated', async () => {
        const storage = memoryStore();
        const first = new FlowDefinitionStore(storage);
        const draft = { id: 'builtin', name: 'Builtin', nodes: [], edges: [], draftVersion: 1, updatedAt: 0, layout: {} } as FlowDraft;
        expect(await first.installBuiltinDraft(draft)).not.toBeNull();
        await storage.deleteFile('/builtin.flow');
        const restarted = new FlowDefinitionStore(storage);
        expect(await restarted.installBuiltinDraft(draft)).toBeNull();
        expect(await restarted.listDrafts()).toEqual([]);
        expect(await storage.findFile('builtin.flow')).toBeNull();
    });
    it('records existing templates without overwriting edits and respects a later deletion', async () => {
        const storage = memoryStore(); const store = new FlowDefinitionStore(storage);
        const existing = await store.createDraft({ id: 'builtin', name: 'User edited' });
        expect(await store.installBuiltinDraft({ ...existing, name: 'Replacement' })).toBeNull();
        expect((await store.loadDraft('builtin'))?.name).toBe('User edited');
        await storage.deleteFile('/builtin.flow');
        expect(await new FlowDefinitionStore(storage).installBuiltinDraft(existing)).toBeNull();
    });
});

it('explicitly restores a missing builtin without overwriting edits or enabling startup resurrection', async () => {
    const storage = memoryStore(); const store = new FlowDefinitionStore(storage);
    const template = { id: 'builtin', name: 'Builtin', nodes: [], edges: [], draftVersion: 1, updatedAt: 0, layout: {} } as FlowDraft;
    await store.installBuiltinDraft(template);
    await storage.deleteFile('/builtin.flow');
    const restored = await store.installBuiltinDraft(template, { restoreMissing: true });
    expect(restored?.id).toBe('builtin');
    await store.saveDraft({ ...restored!, name: 'Edited' }, restored!.draftVersion);
    expect(await store.installBuiltinDraft(template, { restoreMissing: true })).toBeNull();
    expect((await store.loadDraft('builtin'))?.name).toBe('Edited');
    await storage.deleteFile('/builtin.flow');
    expect(await new FlowDefinitionStore(storage).installBuiltinDraft(template)).toBeNull();
});

it('pins variables and assignments in immutable revision digests', async () => {
    const store = new FlowDefinitionStore(memoryStore());
    const draft = await store.createDraft({ id: 'vars', name: 'Vars' });
    draft.variables = { essay: { type: 'string', initial: '${param.essay}' } };
    draft.nodes = [{ id: 'write' as never, name: 'write', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: { essay: 'NEW' } }, assign: { essay: '${output.essay}' } }];
    const first = await store.createRevision(draft);
    draft.variables.essay.initial = 'OTHER';
    const second = await store.createRevision(draft);
    expect((await store.loadRevision('vars', 1))?.variables?.essay.initial).toBe('${param.essay}');
    expect(first.nodes[0].assign).toEqual({ essay: '${output.essay}' });
    expect(first.digest).not.toBe(second.digest);
});

function libraryCommands() {
    const plugins = createBuiltinDagPluginRegistry(), files = memoryStore(), store = new FlowDefinitionStore(files, plugins);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    new DagCommandService({ kernel: {} as never, plugins, flowStore: store })
        .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
    const template: FlowDraft = JSON.parse(readFileSync(new URL('../../app-core/src/presets/essay-review.json', import.meta.url), 'utf8'));
    return { store, files, template, execute: (name: string, args: unknown) => handlers.get(name)!(args) };
}

it('installs, validates, saves and publishes the bundled variable Flow through real commands', async () => {
    const { store, files, template, execute } = libraryCommands();
    await expect(execute(FlowCommand.DraftInstall, template)).resolves.toMatchObject({ variables: template.variables });
    await expect(execute(FlowCommand.DraftValidate, template)).resolves.toMatchObject({ valid: true });
    const installed = (await store.loadDraft(template.id))!;
    const saved = await execute(FlowCommand.DraftSave, { draft: { ...installed, name: 'User edited' }, expectedDraftVersion: installed.draftVersion });
    expect(saved.valid).toBe(true);
    const published = await execute(FlowCommand.RevisionCreate, { draftId: template.id, expectedDraftVersion: saved.draft.draftVersion });
    expect(published.revision.variables).toEqual(template.variables);
    expect(published.revision.nodes.find((node: any) => node.id === 'rewrite').assign).toEqual({ essay: '${output.essay}' });
    await execute(FlowCommand.DraftInstall, template);
    expect((await store.loadDraft(template.id))?.name).toBe('User edited');
    await files.deleteFile((await files.findFile(`${template.id}.flow`))!.nodeId);
    await expect(execute(FlowCommand.DraftInstall, template)).resolves.toBeNull();
    await expect(execute(FlowCommand.DraftRestore, template)).resolves.toMatchObject({ variables: template.variables });
    expect(await store.loadRevision(template.id)).toEqual(published.revision);
});

it('restores a draft without implicitly creating a published revision', async () => {
    const { store, template, execute } = libraryCommands();
    await execute(FlowCommand.DraftRestore, template);
    expect(await store.loadRevision(template.id)).toBeNull();
});

async function callableDrafts() {
    const context = libraryCommands(), { store } = context;
    const child = await store.createDraft({ id: 'child', name: 'Child' });
    child.parameters = [{ name: 'word', type: 'string', required: true }];
    child.nodes = [{ id: 'work' as never, name: 'Work', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: '${param.word}' } }];
    child.outputs = { result: { value: '${nodes.work.outputs.result}' } };
    await store.createRevision(child);
    const parent = await store.createDraft({ id: 'parent', name: 'Parent' });
    parent.nodes = [{ id: 'call' as never, name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId: 'child', parameters: {} } }];
    return { ...context, parent };
}

it.each([{ wrod: 'hello' }, {}, { word: 42 }])('rejects invalid call bindings in source checks and publication: %j', async parameters => {
    const { store, parent, execute } = await callableDrafts();
    parent.nodes[0].config = { flowId: 'child', parameters };
    const saved = await execute(FlowCommand.DraftSave, { draft: parent, expectedDraftVersion: parent.draftVersion });
    expect(saved.valid).toBe(false);
    expect(await store.loadDraft('parent')).not.toBeNull();
    expect(await execute(FlowCommand.SourceCheck, { source: saved.draft })).toMatchObject({ valid: false });
    expect(await execute(FlowCommand.DraftValidate, saved.draft)).toMatchObject({ valid: false });
    await expect(execute(FlowCommand.RevisionCreate, { draftId: 'parent', expectedDraftVersion: saved.draft.draftVersion })).rejects.toThrow(/Flow parameter|required parameter|must be string/);
    await expect(store.createRevision(saved.draft)).rejects.toThrow(/Flow parameter|required parameter|must be string/);
    expect(await store.loadRevision('parent')).toBeNull();
    const corrected = await execute(FlowCommand.DraftSave, { draft: { ...saved.draft, nodes: [{ ...saved.draft.nodes[0], config: {
        flowId: 'child', parameters: { word: 'hello' },
    } }] }, expectedDraftVersion: saved.draft.draftVersion });
    expect(corrected.valid).toBe(true);
    expect(await execute(FlowCommand.RevisionCreate, { draftId: 'parent', expectedDraftVersion: corrected.draft.draftVersion }))
        .toMatchObject({ revision: { dependencyLocks: { call: { flowId: 'child', revision: 1 } } } });
});

it('still rejects an actually undeclared variable before installing any file', async () => {
    const { store, template, execute } = libraryCommands();
    delete template.variables;
    await expect(execute(FlowCommand.DraftInstall, template)).rejects.toThrow('Undeclared Flow variable');
    expect(await store.loadDraft(template.id)).toBeNull();
    expect(await store.listDrafts()).toEqual([]);
});

it('pins a published parent to its transitive child revisions after the child is edited', async () => {
    const store = new FlowDefinitionStore(memoryStore(), createBuiltinDagPluginRegistry());
    const child = await store.createDraft({ id: 'child', name: 'Child' });
    child.outputs = { result: { value: 'first' } };
    const firstChild = await store.createRevision(child);
    const parent = await store.createDraft({ id: 'parent', name: 'Parent' });
    parent.nodes = [{ id: 'call' as never, name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId: 'child', parameters: {} } }];
    parent.outputs = { result: { value: '${nodes.call.outputs.result}' } };
    const firstParent = await store.createRevision(parent);
    child.outputs.result.value = 'second';
    await store.createRevision(child);
    const persisted = (await store.loadRevision('parent', firstParent.revision))!;
    expect(persisted.dependencyLocks?.call).toMatchObject({ revision: firstChild.revision, digest: firstChild.digest });
    const graph = await flowToDag(persisted, undefined, undefined, (id, revision) => store.loadRevision(id, revision));
    expect(graph.nodes.find(node => node.id === 'call/__flow_return')?.config).toMatchObject({ returns: { result: { value: 'first' } } });
    const secondParent = await store.createRevision(parent);
    expect(secondParent.dependencyLocks?.call.revision).toBe(2);
    expect(secondParent.digest).not.toBe(firstParent.digest);
});

it.each(['missing', 'throws'])('creates distinct Flow identities in the same millisecond when native UUID %s', mode => {
    vi.stubGlobal('crypto', mode === 'throws' ? {randomUUID: () => {throw new Error('Native UUID unavailable');}} : {});
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1792300000000);
    try {
        const ids = Array.from({length: 100}, () => generateFlowId('New Flow'));
        expect(new Set(ids).size).toBe(100); expect(ids.every(id => /^new-flow-[a-z0-9-]{8}$/.test(id))).toBe(true);
    } finally {clock.mockRestore(); vi.unstubAllGlobals();}
});

it('publishes inline callable revisions and their dependency locks in one stored Flow', async () => {
    const storage = memoryStore(), store = new FlowDefinitionStore(storage, createBuiltinDagPluginRegistry());
    const parent = await store.createDraft({ id: 'single-file', name: 'Single file' });
    parent.nodes = [{ id: 'invoke' as never, name: 'Invoke', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId: 'local', parameterSets: [{}] } }];
    parent.functions = [{ ...parent, id: 'local' as never, name: 'Local', functions: undefined,
        nodes: [{ id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'original' } }],
        outputs: { result: { value: '${nodes.value.outputs.result}' } } }];
    const first = await store.createRevision(parent);
    expect((await storage.listFiles()).filter(file => file.name.endsWith('.flow'))).toHaveLength(1);
    expect(first.functions![0]).toMatchObject({ id: 'local', revision: 1 });
    expect(first.dependencyLocks!.invoke).toMatchObject({ flowId: 'local', revision: 1, digest: first.functions![0].digest });
    const saved = (await store.loadRevision('single-file', 1))!;
    expect((await flowToDag(saved)).functionCalls!.invoke__input.child.nodes.some(node => node.id === 'value')).toBe(true);
    parent.functions![0].nodes[0].config = { value: 'changed' };
    const second = await store.createRevision(parent);
    expect(second.functions![0].revision).toBe(2);
    expect(second.functions![0].digest).not.toBe(first.functions![0].digest);
    expect((await store.loadRevision('single-file', 1))!.functions![0].nodes[0].config).toEqual({ value: 'original' });
});
