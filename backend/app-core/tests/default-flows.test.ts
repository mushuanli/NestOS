import { describe, expect, it } from 'vitest';
import type { FlowStore } from '@itookit/llm-flow';
import { FlowDefinitionStore } from '@itookit/llm-flow';
import { essayReviewDraft, seedDefaultFlows, ESSAY_REVIEW_FLOW_ID } from '../src/presets/default-flows';

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
    it('declares connection slots and routes verdict/report to premium', () => {
        const draft = essayReviewDraft();
        expect(draft.connections?.map(connection => connection.name)).toEqual(['default', 'premium']);
        expect(draft.defaultConnection).toBe('default');
        const verdict = draft.nodes.find(node => node.id === 'verdict');
        const report = draft.nodes.find(node => node.id === 'report');
        expect((verdict?.config as Record<string, unknown>).connectionId).toBe('premium');
        expect((report?.config as Record<string, unknown>).connectionId).toBe('premium');
    });

    it('seeds connections into both the persisted draft and revision', async () => {
        const store = new FlowDefinitionStore(memoryStore());
        await seedDefaultFlows(store);
        const draft = await store.loadDraft(ESSAY_REVIEW_FLOW_ID);
        expect(draft?.connections?.map(connection => connection.name)).toEqual(['default', 'premium']);
        expect(draft?.defaultConnection).toBe('default');
        const revision = await store.loadRevision(ESSAY_REVIEW_FLOW_ID, 1);
        expect(revision?.connections?.map(connection => connection.name)).toEqual(['default', 'premium']);
        expect(revision?.defaultConnection).toBe('default');
    });
});

it('does not recreate the legacy essay Flow after deletion and restart', async () => {
    const storage = memoryStore();
    await seedDefaultFlows(new FlowDefinitionStore(storage));
    await storage.deleteFile(`/${ESSAY_REVIEW_FLOW_ID}.flow`);
    const restarted = new FlowDefinitionStore(storage);
    await seedDefaultFlows(restarted);
    expect(await restarted.loadDraft(ESSAY_REVIEW_FLOW_ID)).toBeNull();
});
