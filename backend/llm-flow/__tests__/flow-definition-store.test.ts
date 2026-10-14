import { readFileSync } from 'node:fs';
import { DagCommandService } from '../src/flow/commands';
import { FlowCommand } from '../src/flow/command-names';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';
import { describe, expect, it } from 'vitest';
import type { FlowDraft, FlowRevision } from '../src/contracts';
import type { FlowStore } from '../src/flow-definition-store';
import { FlowDefinitionStore } from '../src/flow-definition-store';
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
    const template: FlowDraft = JSON.parse(readFileSync(new URL('../../app-core/src/presets/essay-review-isolated.json', import.meta.url), 'utf8'));
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
