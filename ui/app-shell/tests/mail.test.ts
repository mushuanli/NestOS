// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, type IFileSystem} from '@itookit/vfs-core';
import {MailArchive} from '../src/mail/read';
import {MailWorkbench} from '../src/mail';
import {accountNodes, mailNodes} from '../src/mail/source';
import {parseMail} from '../src/mail/model';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks();});
async function write(files: IFileSystem, path: string, content: string) {
    const parentPath = path.slice(0, path.lastIndexOf('/')) || '/';
    let parent = '/';
    for (const name of parentPath.split('/').filter(Boolean)) {
        const path = parent.replace(/\/$/, '') + '/' + name;
        if (!await files.driver.exists(path)) await files.driver.createDirectory({name, parentPath: parent});
        parent = path;
    }
    return files.driver.createFile({name: path.slice(path.lastIndexOf('/') + 1), parentPath, content});
}
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const files = await manager.openFileSystem('/emails');
    for (const [provider, account] of [['first', 'one'], ['second', 'two']]) {
        const directory = '/' + provider + '/' + account;
        await write(files, directory + '/.mail-source.json', JSON.stringify({format: 'nestos.mail-source', version: 1,
            provider: {id: provider, name: provider}, account: {id: account, name: account + '@example.test'}, name: 'Inbox'}));
        await write(files, directory + '/same.email', 'Subject: ' + account + '\nFrom: sender@example.test\nTo: inbox@example.test\nDate: Sun, 1 Nov 2026 11:00:00 +0800\n\n<script>privateBody()</script>');
        await write(files, directory + '/.sync.json', 'private checkpoint');
    }
    return {files, archive: new MailArchive(files)};
}
it('keeps provider/account identities separate, hides sync state and reuses unchanged header reads', async () => {
    const {archive, files} = await fixture(), signal = new AbortController().signal;
    const first = await archive.read(signal);
    expect(first.messages).toHaveLength(2); expect(first.sources).toHaveLength(2); expect(first.warnings).toEqual([]);
    expect(new Set(first.messages.map(message => message.id)).size).toBe(2);
    expect(mailNodes(first, '/first/one', files.viewId)).toMatchObject([{label: 'one'}]);
    expect(accountNodes(first).filter(node => node.kind === 'group').map(node => node.label)).toEqual(['first', 'second']);
    expect(JSON.stringify(first)).not.toContain('privateBody'); expect(JSON.stringify(first)).not.toContain('checkpoint');
    const read = vi.spyOn(files.driver, 'readContent'); await archive.read(signal);
    expect(read.mock.calls.every(([path]) => path.endsWith('.mail-source.json'))).toBe(true);
});
it('reports malformed sources and oversized messages without leaking content', async () => {
    const {archive, files} = await fixture();
    await write(files, '/broken/.mail-source.json', '{private-body');
    await write(files, '/broken/huge.email', 'private-body'.repeat(60000));
    const snapshot = await archive.read(new AbortController().signal);
    expect(snapshot.messages).toHaveLength(2); expect(snapshot.warnings).toContain('MAIL_SOURCE_INVALID'); expect(snapshot.warnings).toContain('MAIL_FILE_TOO_LARGE');
    expect(JSON.stringify(snapshot.warnings)).not.toContain('private-body');
});
it('renders a provider-filterable VFS mailbox and displays hostile content as plain text', async () => {
    const {files} = await fixture(), sidebar = document.createElement('aside'), editor = document.createElement('main');
    document.body.append(sidebar, editor); const selected = vi.fn();
    const workbench = new MailWorkbench({files, sidebar, editor, selected, scanners: async () => {}}); cleanup.push(() => workbench.destroy());
    await workbench.start();
    expect(sidebar.textContent).toContain('one@example.test'); expect(sidebar.textContent).toContain('two@example.test');
    await workbench.openResource('/first/one/same.email');
    expect(editor.querySelector('script')).toBeNull(); expect(editor.querySelector('.mail__body')?.textContent).toBe('<script>privateBody()</script>');
    expect(selected).toHaveBeenLastCalledWith('/first/one/same.email');
    workbench.restoreRecovery({source: '/second/two', query: 'two'});
    expect(workbench.captureRecovery()).toEqual({source: '/second/two', query: 'two'});
});
it('preserves plain legacy email drafts without inventing missing headers', () => {
    expect(parseMail('Legacy draft\n\nBody', 'Draft.email')).toMatchObject({subject: 'Draft.email', body: 'Legacy draft\n\nBody', from: '', date: 0});
});
