import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime, type ApplicationRuntime} from '../src/runtime/create-application-runtime';
import {readConversationIdentity} from '../src/projects/drafts/remote-identity';
import {prepareRemoteDraft} from '../src/projects/drafts/remote-submission';
import {ProjectDraftStore} from '../src/projects/drafts/store';
import {decodeDraftRecord} from '../src/projects/drafts/record-codec';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';
let app: ApplicationRuntime | undefined;
afterEach(async () => {await app?.dispose(); app = undefined;});
async function setup() {
    app = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    const project = await app.projects.create('Remote draft'), folder = await app.projects.sessionFolder(project);
    const root = {at: '/', connectionId: 'connection', serverProjectId: 'native-project', access: 'rw', authorization: {principalId: 'principal'}};
    app.projects.remoteMounts = {list: () => [root], connections: () => []} as never;
    const composer = await app.projects.drafts.open(project.project.id, folder);
    const executor = 'remote:' + encodeURIComponent(JSON.stringify(['connection', 'native-project', 'codex']));
    await composer.save(JSON.stringify({version: 2, config: {agentId: executor, text: 'Original'}, files: []}));
    const fs = await app.vfs.openFileSystem('/');
    const journal = (draftId = composer.id!, profileId = 'codex') => new RemoteConversationStore(fs,
        JSON.stringify([project.project.id, 'connection', 'native-project', 'principal', profileId, draftId]));
    return {project, folder, composer, journal, fs};
}
it('requires a confirmed native turn, keeps the UI UUID and atomically allocates one successor', async () => {
    const f = await setup(), notify = vi.fn(); app!.projects.drafts.onPromoted(notify);
    const journal = f.journal(); await journal.save({sessionId: 'native-1', pending: {epoch: 'epoch', requestId: 'request', operation: 'turn'}, submittedTurnId: 'turn-1'});
    await app!.projects.drafts.reconcile(f.project.project.id); expect(notify).not.toHaveBeenCalled();
    expect((await app!.projects.drafts.open(f.project.project.id, f.folder)).id).toBe(f.composer.id);
    await journal.save({sessionId: 'native-1', submittedTurnId: 'turn-1'});
    const reopened = await app!.projects.drafts.open(f.project.project.id, f.folder);
    expect(reopened.id).not.toBe(f.composer.id);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({draftId: f.composer.id, sessionId: f.composer.id,
        nextDraftId: reopened.id, remote: {connectionId: 'connection', serverProjectId: 'native-project', principalId: 'principal', profileId: 'codex', nativeSessionId: 'native-1', turnId: 'turn-1'}}));
    const reference = {connectionId: 'connection', serverProjectId: 'native-project', principalId: 'principal', profileId: 'codex', nativeSessionId: 'native-1'};
    expect(await readConversationIdentity(f.fs, f.project.project.id, reference)).toBe(f.composer.id);
    expect(await readConversationIdentity(f.fs, f.project.project.id, {...reference, principalId: 'other-principal'})).toBeUndefined();
    await app!.projects.drafts.recover(); expect(notify).toHaveBeenCalledOnce();
    expect(await app!.sessionRepository.list()).toHaveLength(0);
});
it('does not apply another draft or harness receipt to the active new-conversation file', async () => {
    const f = await setup();
    await f.journal('other-draft').save({sessionId: 'other', submittedTurnId: 'turn'});
    await f.journal(f.composer.id, 'claude').save({sessionId: 'other-profile', submittedTurnId: 'turn'});
    await app!.projects.drafts.recover(); expect((await app!.projects.drafts.open(f.project.project.id, f.folder)).id).toBe(f.composer.id);
});

const target = {connectionId: 'connection', serverProjectId: 'native-project', principalId: 'principal', profileId: 'codex'};
it('recovers a frozen native submission after another view edits the executor preference', async () => {
    const f = await setup(); await prepareRemoteDraft(f.fs, f.project.project.id, f.composer.id!, target);
    const journal = f.journal(); await journal.save({sessionId: 'native-1', pending: {epoch: 'e', requestId: 'request-1', operation: 'turn'}});
    const second = await app!.projects.drafts.open(f.project.project.id, f.folder);
    await second.save(JSON.stringify({version: 2, config: {agentId: 'remote:' + encodeURIComponent(JSON.stringify(['connection', 'native-project', 'claude'])), text: 'Later draft'}, files: []}));
    await journal.save({sessionId: 'native-1', submittedTurnId: 'turn-1'});
    await app!.projects.drafts.reconcile(f.project.project.id);
    expect((await app!.projects.drafts.open(f.project.project.id, f.folder)).id).not.toBe(f.composer.id);
    expect(await readConversationIdentity(f.fs, f.project.project.id, {...target, nativeSessionId: 'native-1'})).toBe(f.composer.id);
});
it('retains one submission across concurrent preparation, edits and reopening, and rejects another executor', async () => {
    const f = await setup(), store = () => new ProjectDraftStore(f.fs, f.project.project.id);
    const first = store(), second = store(); await Promise.all([first.load(), second.load()]);
    const [one, two] = await Promise.all([first.begin('Title', target), second.begin('Title', {...target})]);
    expect(one.submissionId).toBe(two.submissionId);
    await f.composer.save(JSON.stringify({version: 2, config: {agentId: 'changed', text: 'Later text'}, files: []}));
    const reopened = await store().load();
    expect(reopened.remoteTarget).toEqual(target); expect(reopened.submissionId).toBe(one.submissionId);
    await expect(prepareRemoteDraft(f.fs, f.project.project.id, f.composer.id!, {...target, profileId: 'claude'})).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(decodeDraftRecord(JSON.stringify(reopened)).record.remoteTarget).toEqual(target);
});
it('does not discard a remote submission whose outcome is still unknown', async () => {
    const f = await setup(); await prepareRemoteDraft(f.fs, f.project.project.id, f.composer.id!, target);
    await f.journal().save({sessionId: 'native-1', pending: {epoch: 'e', requestId: 'request', operation: 'turn'}});
    await expect(f.composer.clear()).rejects.toMatchObject({code: 'EBUSY'});
    expect((await app!.projects.drafts.open(f.project.project.id, f.folder)).id).toBe(f.composer.id);
});
it('rejects malformed persisted submission targets', () => {
    expect(() => decodeDraftRecord(JSON.stringify({version: 1, id: 'draft', state: 'submitting', data: '', sessionId: 'draft', submissionId: 'operation', remoteTarget: {...target, profileId: 42}}))).toThrow();
});
