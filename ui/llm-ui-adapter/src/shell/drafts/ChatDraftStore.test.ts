import {expect, it} from 'vitest';
import {randomUUID} from '@itookit/common';
import {ChatDraftStore} from './ChatDraftStore';
it('round-trips shared attachment identities through the existing project draft format', async () => {
    const binaries = new Map<string, ArrayBuffer>(); let data = '';
    const controls = {materialize: async () => {throw new Error('Not materialized');}, save: async (value: string) => {data = value;},
        attachments: {put: async (value: ArrayBuffer) => {const id = randomUUID(); binaries.set(id, value); return id;}, read: async (id: string) => binaries.get(id)!}};
    const store = new ChatDraftStore(controls); await store.open();
    const file = await store.upload(new File(['draft content'], 'draft.txt', {type: 'text/plain'}), {signal: new AbortController().signal});
    const logicalId = randomUUID(), draft = {...store.draft, revision: 3, textRevision: 2, text: 'Keep text',
        selection: {executionMode: 'agent', modelTier: 'fast'}, attachments: [{id: logicalId, revision: 7, file}]};
    await store.save(draft);
    const stored = JSON.parse(data); expect(stored.version).toBe(2); expect(stored.files[0].fileId).toBe(logicalId);
    const restored = new ChatDraftStore({...controls, initialData: data}); await restored.open();
    expect(restored.draft).toEqual(JSON.parse(JSON.stringify(draft))); expect(restored.preferences().settings).toMatchObject({executionMode: 'agent', modelTier: 'fast'});
    expect((await restored.readFiles(restored.draft.attachments.map(item => item.file)))[0].name).toBe('draft.txt');
});
