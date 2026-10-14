import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';
it('persists inline native draft attachments with CAS and rejects malformed or excessive recovery data', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), first = new RemoteConversationStore(fs, 'key');
        const record = {draft: 'Review', draftAttachments: [{kind: 'text' as const, name: 'notes.md', content: '中文\nquoted "text"'}]};
        await first.load(); await first.save(record);
        const second = new RemoteConversationStore(fs, 'key'); expect(await second.load()).toEqual(record);
        await first.save({...record, draft: 'Updated'});
        await expect(second.save(record)).rejects.toMatchObject({code: 'ECONFLICT'});
        await expect(first.save({...record, draftAttachments: [{...record.draftAttachments[0], content: 'x'.repeat(65537)}]})).rejects.toMatchObject({code: 'EINVAL'});
        await fs.meta.seq!.setEntry('/etc/fs/harness-conversations.seq', 'key', JSON.stringify({...record, draftAttachments: [{kind: 'image', name: 'private', mimeType: 'image/png', content: 'http://localhost/private'}]}));
        await expect(new RemoteConversationStore(fs, 'key').load()).rejects.toMatchObject({code: 'EINVAL'});
    } finally {await manager.dispose();}
});
