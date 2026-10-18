import { expect, it } from 'vitest';
import { conversationResourcePath, projectConversationEntryPath, projectConversationsPath, remoteSessionPath, resolveBrowserTarget } from '@itookit/app-contracts';

it('keeps canonical identities for namesakes from different harnesses and round-trips source cursors', () => {
    const folder = '/项目', recent = projectConversationsPath(folder, {recent: true});
    const resources = ['codex', 'claudecode', 'profile two'].map(id => remoteSessionPath(folder, id, 'same'));
    const entries = resources.map(resource => projectConversationEntryPath(recent, resource));
    expect(new Set(entries).size).toBe(3);
    entries.forEach((entry, i) => {
        expect(conversationResourcePath(entry)).toBe(resources[i]);
        expect(resolveBrowserTarget(entry)).toMatchObject({kind: 'remote', nativeSessionId: 'same', folder});
    });
    const cursor = JSON.stringify({'remote:profile two': {cursor: 'older/before+=中文', offset: 2}});
    const page = projectConversationsPath(folder, {cursor});
    expect(resolveBrowserTarget(page)).toMatchObject({kind: 'project-conversations', cursor});
    expect(conversationResourcePath(projectConversationEntryPath(recent, page))).toBe(page);
    expect(resolveBrowserTarget(page + '/@page:' + encodeURIComponent(cursor))).toMatchObject({cursor});
});

it('rejects malformed, nested and cross-project collection entries', () => {
    const root = projectConversationsPath('/Project'), other = remoteSessionPath('/Other', 'codex', 's');
    for (const path of [root + '/unknown', root + '/@page:', root + '/@page:%00', root + '/@page:%',
        projectConversationEntryPath(root, other), projectConversationEntryPath(root, projectConversationEntryPath(root, remoteSessionPath('/Project', 'codex', 's')))])
        expect(() => resolveBrowserTarget(path)).toThrow();
});
