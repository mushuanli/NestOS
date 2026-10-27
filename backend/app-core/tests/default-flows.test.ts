import { describe, expect, it } from 'vitest';
import type { FlowStore } from '@itookit/llm-flow';
import { FlowDefinitionStore } from '@itookit/llm-flow';
import { createNestosFlowLibrary, createNestosFlowDrawers } from '../src/presets/flow-library';
import { essayReviewDraft, seedDefaultFlows, ESSAY_REVIEW_FLOW_ID } from '../src/presets/default-flows';
import { externalFlow } from './fixtures/flow-library';

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

describe('default essay-review flow', () => {
    it('uses the single current implementation with isolated review and explicit loop controls', () => {
        const draft = essayReviewDraft();
        expect(draft.id).toBe('essay-review');
        expect(draft.nodes.map(node => node.plugin)).toEqual(expect.arrayContaining(['builtin.loop', 'builtin.taskGroup', 'builtin.join']));
        expect(draft.variables?.essay).toEqual({ type: 'string', initial: '${param.essay}' });
        expect(draft.nodes.find(node => node.id === 'report')?.plugin).toBe('builtin.transform');
    });

    it('publishes the same current template once with its variables and control settings', async () => {
        const store = new FlowDefinitionStore(memoryStore());
        await seedDefaultFlows(store);
        const draft = await store.loadDraft(ESSAY_REVIEW_FLOW_ID);
        expect(draft?.parameters?.find(parameter => parameter.name === 'maxRounds')?.default).toBe(10);
        const revision = await store.loadRevision(ESSAY_REVIEW_FLOW_ID, 1);
        expect(revision?.nodes).toEqual(draft?.nodes);
        expect(revision?.variables).toEqual(draft?.variables);
        expect(await store.loadDraft('essay-review-isolated')).toBeNull();
    });
});

it('does not recreate the current essay Flow after deletion and restart', async () => {
    const storage = memoryStore();
    await seedDefaultFlows(new FlowDefinitionStore(storage));
    await storage.deleteFile(`/${ESSAY_REVIEW_FLOW_ID}.flow`);
    const restarted = new FlowDefinitionStore(storage);
    await seedDefaultFlows(restarted);
    expect(await restarted.loadDraft(ESSAY_REVIEW_FLOW_ID)).toBeNull();
});

it('installs product templates in the backend and preserves user edits and deletion receipts', async () => {
    const storage = memoryStore(), store = new FlowDefinitionStore(storage);
    const template = createNestosFlowLibrary()[0];
    await seedDefaultFlows(store);
    const loaded = (await store.loadDraft(template.id))!;
    expect(loaded.parameters?.find(parameter => parameter.name === 'maxRounds')?.default).toBe(10);
    await store.saveDraft({ ...loaded, name: 'User edited' }, loaded.draftVersion);
    await seedDefaultFlows(store); expect((await store.loadDraft(template.id))?.name).toBe('User edited');
    await storage.deleteFile(`/${template.id}.flow`);
    await seedDefaultFlows(new FlowDefinitionStore(storage));
    expect(await new FlowDefinitionStore(storage).loadDraft(template.id)).toBeNull();
});

it('uses one essay template and one Anki entry while preserving explicitly installed external flows on restart', async () => {
    const storage = memoryStore(), store = new FlowDefinitionStore(storage);
    const external = externalFlow('external-workflow');
    await store.installBuiltinDraft(external);
    await seedDefaultFlows(store);
    expect((await store.listDrafts()).map(draft => draft.id).sort()).toEqual([
        'anki-generate', 'essay-review', 'external-workflow',
    ]);
    expect(createNestosFlowLibrary().map(draft => draft.id)).toEqual(['essay-review', 'anki-generate']);
    expect(createNestosFlowDrawers()).toEqual([]);
    await seedDefaultFlows(new FlowDefinitionStore(storage));
    expect(await store.loadDraft(external.id)).toMatchObject({ name: external.name });
});

it.each(['essay-review', 'essay-review-isolated'])('keeps existing %s files and revisions while offering one canonical template', async id => {
    const storage = memoryStore(), store = new FlowDefinitionStore(storage);
    const previous = externalFlow(id); previous.name = 'Existing legacy essay with personal edits';
    const installed = (await store.installBuiltinDraft(previous))!;
    const published = await store.createRevision(installed);
    await seedDefaultFlows(store);
    expect(await store.loadDraft(id)).toEqual(installed);
    expect(await store.loadRevision(id, published.revision)).toEqual(published);
    expect(createNestosFlowLibrary().filter(flow => flow.id.startsWith('essay-review')).map(flow => flow.id)).toEqual(['essay-review']);
});
