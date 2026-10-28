// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {FileRecoveryStore, setFileRecoveryOwner} from '../../../ui/app-shell/src/persistence/file-recovery-store';
afterEach(() => {sessionStorage.clear(); setFileRecoveryOwner('');});
it('keeps recovery drafts separate for equal logical paths and tabs across users', async () => {
    setFileRecoveryOwner('admin');
    await new FileRecoveryStore('notes', '/same.txt').write({base: 'base', text: 'admin-draft'});
    setFileRecoveryOwner('alice');
    const alice = new FileRecoveryStore('notes', '/same.txt');
    expect(await alice.read()).toBeUndefined();
    await alice.write({base: 'base', text: 'alice-draft'});
    setFileRecoveryOwner('admin');
    expect(await new FileRecoveryStore('notes', '/same.txt').read()).toMatchObject({text: 'admin-draft'});
});
