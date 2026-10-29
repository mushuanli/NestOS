import {expect, it, vi} from 'vitest';
import {randomUUID} from '@itookit/common';
import {NativeChatStore} from './native-store';
import type {ConversationControls} from '@itookit/ui-common';
import {DEFAULT_IMAGE_SPEC} from '@itookit/image-parser';
function fixture(document: object = {}) {
    let state = {revision: '0', data: Object.keys(document).length ? JSON.stringify(document) : '', acceptedOperationIds: [] as string[]};
    const binaries = new Map<string, ArrayBuffer>(), send = vi.fn(), command = vi.fn();
    const controls = {send, command, snapshot: () => ({sessionId: 'native', pending: !!(document as {remoteSubmission?: unknown}).remoteSubmission}),
        readComposerDraft: async () => structuredClone(state),
        saveComposerDraft: async (data: string, revision: string, operationId: string) => {
            expect(revision).toBe(state.revision); state = {revision: String(Number(revision) + 1), data, acceptedOperationIds: [...state.acceptedOperationIds, operationId]}; return structuredClone(state);
        }, putComposerAsset: async (bytes: ArrayBuffer) => {const id = randomUUID(); binaries.set(id, bytes); return id;},
        readComposerAsset: async (id: string) => {const value = binaries.get(id); if (!value) throw new Error('Missing native binary'); return value;}} as unknown as ConversationControls;
    return {controls, send, command, state: () => state};
}
it('imports an uncertain legacy submission without resending or consuming later typing', async () => {
    const draftToken = randomUUID();
    const frozen = JSON.stringify({version: 2, config: {draftToken, text: 'Submitted', agentId: 'remote', settings: {}}, files: []});
    const f = fixture({version: 2, config: {draftToken, text: 'Typed later', agentId: 'remote', settings: {}}, files: [], composerVersion: 2,
        remoteSubmission: {id: 'original-operation', base: frozen, version: 1, kind: 'message'}});
    const store = (await NativeChatStore.open(f.controls))!, ledger = store.ledger();
    expect(store.draft.text).toBe('Typed later'); expect(ledger.getSnapshot()).toHaveLength(1);
    expect(ledger.getSnapshot()[0]).toMatchObject({kind: 'send', status: 'unknown', context: {operationId: 'original-operation'},
        draft: {text: 'Submitted', scopeId: store.draft.scopeId, textRevision: 1}});
    await ledger.settle({operationId: 'original-operation', status: 'accepted'});
    expect(JSON.parse(f.state().data).remoteSubmission).toBeUndefined(); expect(store.draft.text).toBe('Typed later');
    const reopened = (await NativeChatStore.open(f.controls))!; expect(reopened.ledger().getSnapshot()).toHaveLength(1);
    expect(f.send).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
});
it('retains both the processed attachment and its original image across a host handoff', async () => {
    const f = fixture(), store = (await NativeChatStore.open(f.controls))!;
    const refs = new Map([['processed', new Uint8Array([1]).buffer], ['original', new Uint8Array([2, 3]).buffer]]);
    const metadata = {original: {id: 'original', name: 'raw.png', mimeType: 'image/png'}, spec: DEFAULT_IMAGE_SPEC, resize: {mode: 'original' as const}};
    const draft = {...store.draft, revision: 1, attachments: [{id: randomUUID(), revision: 4, file: {id: 'processed', name: 'image.png', mimeType: 'image/png'}}]};
    await store.retainDraft(draft, async id => refs.get(id)!, new AbortController().signal, {loadMetadata: async () => metadata} as never);
    refs.clear(); const restored = (await NativeChatStore.open(f.controls))!;
    const image = restored.images.host(() => ({mode: 'original'}), () => {});
    expect(await image.loadMetadata(draft.attachments[0].file)).toEqual(metadata);
    expect(new Uint8Array(await (await image.read(metadata.original, {signal: new AbortController().signal})).arrayBuffer())).toEqual(new Uint8Array([2, 3]));
    expect(restored.draft.attachments[0]).toEqual(draft.attachments[0]);
});
