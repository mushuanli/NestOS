import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {ConversationComposerStore} from '../src/projects/conversation-composer-store';

it('persists opaque drafts and originals with CAS, idempotent receipts and owner-scoped asset reads', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        const first = new ConversationComposerStore(fs, 'project', 'conversation', true, () => {});
        const other = new ConversationComposerStore(fs, 'project', 'other', true, () => {});
        const id = await first.putComposerAsset(new Uint8Array([1, 2, 3]).buffer);
        expect(new Uint8Array(await first.readComposerAsset(id))).toEqual(new Uint8Array([1, 2, 3]));
        await expect(other.readComposerAsset(id)).rejects.toMatchObject({code: 'ENOENT'});
        const accepted = await first.saveComposerDraft('original-and-crop', '0', 'edit-1');
        expect(await first.saveComposerDraft('original-and-crop', '0', 'edit-1')).toEqual(accepted);
        const reopened = new ConversationComposerStore(fs, 'project', 'conversation', true, () => {});
        expect(await reopened.readComposerDraft()).toEqual(accepted);
        await expect(reopened.saveComposerDraft('stale', '0', 'edit-2')).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(await reopened.saveComposerDraft('updated', accepted.revision, 'edit-2')).toMatchObject({data: 'updated', acceptedOperationIds: ['edit-1', 'edit-2']});
        await expect(new ConversationComposerStore(fs, 'project', 'conversation', false, () => {}).saveComposerDraft('', '0', 'readonly')).rejects.toMatchObject({code: 'EACCES'});
        await expect(first.readComposerAsset('../other')).rejects.toMatchObject({code: 'ENOENT'});
    } finally {await manager.dispose();}
});
