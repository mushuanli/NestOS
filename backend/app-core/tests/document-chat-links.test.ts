import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {DOCUMENT_CHAT_META_KEY} from '@itookit/app-contracts';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {bindLocalApplicationServices} from '../src/host/application-services';
import {DocumentChatFileView} from '../src/document-chat/file';
import {documentChatBacklinks} from '../src/document-chat/backlinks';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {for (const stop of stops.splice(0).reverse()) await stop();});
async function setup() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false});
    stops.push(() => runtime.dispose());
    const files = await runtime.vfs.openFileSystem('/home/admin/minds');
    await files.driver.createFile({parentPath: '/', name: 'note.md', content: 'Note'});
    const services = bindLocalApplicationServices(runtime);
    const receipt = vi.fn(async () => ({status: 'accepted'})); services.commandBus = {...services.commandBus, execute: receipt} as never;
    const port = new DocumentChatFileView(services, {files, path: '/note.md'}); stops.push(() => port.dispose());
    const meta = async () => (await files.driver.getNode('/note.md'))!.metadata[DOCUMENT_CHAT_META_KEY] as any;
    const request = (endpoint: {sessionId: string; branch: string}, id: string) => ({expectedSessionId: endpoint.sessionId,
        expectedBranch: endpoint.branch, expectedTarget: {kind: 'agent', id: 'default', version: '1', digest: 'default'},
        submission: {id, source: {kind: 'conversation', ownerId: endpoint.sessionId, id}}}) as SubmissionRequest;
    const bind = async (anchor: string, id = 'initial-round') => {
        const reserved = await port.reserve(anchor, id), endpoint = reserved.endpoint!;
        await runtime.sessionRepository.ensureSession(endpoint.sessionId, 'Linked');
        await runtime.sessionRepository.updateManifest(endpoint.sessionId, {currentBranch: endpoint.branch, branches: {[endpoint.branch]: null}});
        const submission = request(endpoint, id); await port.prepare(anchor, submission); return port.bind(anchor, submission);
    };
    return {runtime, services, files, port, meta, receipt, request, bind};
}
it('leaves ordinary Markdown untouched, then scopes independent anchors to the document', async () => {
    const f = await setup(); expect(await f.port.get('absent')).toEqual({}); expect(await f.meta()).toBeUndefined();
    await f.port.reconcile([]); expect(await f.meta()).toBeUndefined();
    const etc = await f.runtime.vfs.openFileSystem('/etc'); expect(await etc.driver.exists('/fs/document-chat-links.seq')).toBe(false);
    const a = await f.port.create('a', 'Selected text'), b = await f.port.create('b', 'Other text');
    expect(a.documentId).toBe(b.documentId); expect(a.id).not.toBe(b.id);
    expect((await f.meta()).anchors.a.selection).toBe('Selected text');
    expect((await f.port.reserve('a', 'retry')).endpoint).toEqual((await f.port.reserve('a', 'retry')).endpoint);
});
it('keeps the initial reply and the same branch across subsequent sends and returns backlinks', async () => {
    const f = await setup(); await f.port.create('a', 'Selection'); const first = await f.bind('a');
    await f.runtime.sessionRepository.writeDocument(first.binding!.sessionId, 'round-initial-round.json', JSON.stringify({status: 'completed',
        output: [{role: 'assistant', content: [{type: 'text', text: '**First**'}]}, {role: 'tool', content: 'private tool result'}]}));
    const next = f.request(first.endpoint!, 'second-round'); await f.port.prepare('a', next); const second = await f.port.bind('a', next);
    expect(second.binding).toEqual(first.binding);
    expect((await f.port.get('a', true)).response).toMatchObject({markdown: '**First**', status: 'completed'});
    expect((await documentChatBacklinks(f.services, first.binding!.sessionId, first.binding!.branch)).map(link => link.anchorId)).toEqual(['a']);
    expect((await f.meta()).anchors.a.binding.initialRoundId).toBe('initial-round');
    expect((await f.meta()).anchors.a.latestRoundId).toBe('second-round');
    expect((await f.port.get('a', true)).activity).toMatchObject({operationId: 'second-round', status: 'pending', markdown: ''});
    await f.runtime.sessionRepository.writeDocument(first.binding!.sessionId, 'round-second-round.json', JSON.stringify({status: 'running',
        output: [{role: 'assistant', content: 'Partial reply'}, {role: 'tool', content: 'private tool result'}]}));
    expect((await f.port.get('a', true)).activity).toMatchObject({operationId: 'second-round', status: 'pending', markdown: 'Partial reply'});
    expect((await f.port.get('a')).activity).toMatchObject({status: 'pending'});
    expect((await f.port.get('a')).activity).not.toHaveProperty('markdown');
    await f.runtime.sessionRepository.writeDocument(first.binding!.sessionId, 'round-second-round.json', JSON.stringify({status: 'completed',
        output: [{role: 'assistant', content: 'Final reply'}]}));
    expect((await f.port.get('a', true)).activity).toMatchObject({status: 'completed', markdown: 'Final reply'});
    expect((await f.port.get('a', true)).response?.markdown).toBe('**First**');
    await f.runtime.sessionRepository.writeDocument(first.binding!.sessionId, 'round-second-round.json', JSON.stringify({status: 'failed'}));
    expect((await f.port.get('a', true)).activity?.status).toBe('failed');

});
it('removes only the deleted branch projection and recovers with a fresh endpoint on explicit send', async () => {
    const f = await setup(); await f.port.create('a', 'A'); await f.port.create('b', 'B'); const first = await f.bind('a');
    await f.runtime.sessionRepository.updateManifest(first.binding!.sessionId, {branches: {main: null}, currentBranch: 'main'});
    expect((await f.port.get('a')).link?.status).toBe('missing');
    expect((await f.meta()).anchors.a.binding).toBeUndefined(); expect((await f.meta()).anchors.b.selection).toBe('B');
    expect(await documentChatBacklinks(f.services, first.binding!.sessionId, first.binding!.branch)).toEqual([]);
    expect((await f.port.reserve('a', 'new-round')).endpoint?.sessionId).not.toBe(first.binding!.sessionId);
});
it('detaches a removed marker and restores its binding on undo without sending again', async () => {
    const f = await setup(); await f.port.create('a', 'A'); const first = await f.bind('a');
    await f.port.reconcile([]); expect(await f.meta()).toBeUndefined();
    expect(await documentChatBacklinks(f.services, first.binding!.sessionId, first.binding!.branch)).toEqual([]);
    await f.port.reconcile(['a']); expect((await f.meta()).anchors.a.binding).toEqual(first.binding);
    expect((await f.port.get('a')).link?.status).toBe('bound');
});
it('preserves unknown submission identity and reconciles an accepted receipt after reopening', async () => {
    const f = await setup(); await f.port.create('a', 'A'); const reserved = await f.port.reserve('a', 'round');
    await f.runtime.sessionRepository.ensureSession(reserved.endpoint!.sessionId, 'Linked');
    await f.runtime.sessionRepository.updateManifest(reserved.endpoint!.sessionId, {branches: {[reserved.endpoint!.branch]: null}});
    const pending = f.request(reserved.endpoint!, 'round'); f.receipt.mockResolvedValue({status: 'unknown'});
    await f.port.prepare('a', pending); await expect(f.port.reserve('a', 'different')).rejects.toMatchObject({code: 'EBUSY'});
    f.receipt.mockResolvedValue({status: 'accepted'});
    const reopened = new DocumentChatFileView(f.services, {files: f.files, path: '/note.md'}); stops.push(() => reopened.dispose());
    const recovered = (await reopened.get('a')).link!;
    expect(recovered.pending).toBeUndefined(); expect(recovered.binding?.initialRoundId).toBe('round');
    await reopened.dispose(); expect(await f.files.driver.exists('/note.md')).toBe(true);
});

it('retains accepted admission when the file projection fails and repairs it on the next read', async () => {
    const f = await setup(); await f.port.create('a', 'A'); const reserved = await f.port.reserve('a', 'round');
    await f.runtime.sessionRepository.ensureSession(reserved.endpoint!.sessionId, 'Linked');
    await f.runtime.sessionRepository.updateManifest(reserved.endpoint!.sessionId, {branches: {[reserved.endpoint!.branch]: null}});
    const request = f.request(reserved.endpoint!, 'round'); await f.port.prepare('a', request);
    vi.spyOn(f.files.driver, 'updateMetadata').mockRejectedValueOnce(Object.assign(new Error('Disk unavailable'), {code: 'EIO'}));
    expect((await f.port.bind('a', request)).projectionPending).toBe(true);
    expect((await f.port.get('a')).link?.projectionPending).toBe(false);
    expect((await f.meta()).anchors.a.binding.initialRoundId).toBe('round');
});
it('does not resurrect a marker removed while its submission receipt was pending', async () => {
    const f = await setup(); await f.port.create('a', 'A'); const reserved = await f.port.reserve('a', 'round');
    await f.runtime.sessionRepository.ensureSession(reserved.endpoint!.sessionId, 'Linked');
    await f.runtime.sessionRepository.updateManifest(reserved.endpoint!.sessionId, {branches: {[reserved.endpoint!.branch]: null}});
    const request = f.request(reserved.endpoint!, 'round'); await f.port.prepare('a', request); await f.port.reconcile([]);
    expect((await f.port.bind('a', request)).status).toBe('detached'); expect(await f.meta()).toBeUndefined();
    await f.port.reconcile(['a']); expect((await f.meta()).anchors.a.binding.initialRoundId).toBe('round');
});
it('follows a rename but gives a copied document an independent identity', async () => {
    const f = await setup(); const original = await f.port.create('a', 'A');
    const stored = await f.meta();
    await f.files.driver.createFile({parentPath: '/', name: 'copy.md', content: '::@a@'});
    await f.files.driver.updateMetadata('/copy.md', {[DOCUMENT_CHAT_META_KEY]: stored});
    const copy = new DocumentChatFileView(f.services, {files: f.files, path: '/copy.md'}); stops.push(() => copy.dispose());
    expect(await copy.get('a')).toEqual({}); expect((await copy.create('a', 'Copied')).documentId).not.toBe(original.documentId);
    await f.files.driver.rename('/note.md', 'renamed.md');
    const renamed = new DocumentChatFileView(f.services, {files: f.files, path: '/renamed.md'}); stops.push(() => renamed.dispose());
    expect((await renamed.get('a')).link?.source.path).toBe('/renamed.md');
    expect((await renamed.get('a')).link?.documentId).toBe(original.documentId);
});

it('keeps one anchor when a persistent source file is opened through another mount depth', async () => {
    const {createFileSystemView} = await import('@itookit/vfs-core');
    const f = await setup(), read = f.files.driver.getNode.bind(f.files.driver);
    vi.spyOn(f.files.driver, 'getNode').mockImplementation(async (...args) => {
        const node = await read(...args); return node ? {...node, sourceIdentity: 'stable-source-file'} : null;
    });
    const first = await f.port.create('a', 'Selection');
    const projected = createFileSystemView({viewId:'another-mount',mounts:[{mountId:'source',at:'/workspace',fs:f.files,access:'rw'}]});
    const other = new DocumentChatFileView(f.services,{files:projected,path:'/workspace/note.md'});
    try {
        const read = (await other.get('a')).link!;
        expect(read.id).toBe(first.id); expect(read.source.fileIdentity).toBe('stable-source-file');
        expect(read.source.path).toBe('/workspace/note.md');
    } finally {await other.dispose(); await projected.dispose();}
});
it('does not overwrite a shared remote anchor when its canonical link is missing in this backend', async () => {
    const f = await setup(); await f.files.driver.updateMetadata('/note.md',{[DOCUMENT_CHAT_META_KEY]:{
        schemaVersion:1,documentId:'foreign-document',anchors:{a:{linkId:'foreign-document:a',status:'bound',binding:{sessionId:'other-backend'}}}}});
    const original = await f.meta(); await expect(f.port.create('a','New selection')).rejects.toMatchObject({code:'ECONFLICT'});
    expect(await f.meta()).toEqual(original);
});

it('reads partial assistant text from the matching live round without changing its completion status', async () => {
    const f = await setup(); await f.port.create('a', 'A'); const bound = await f.bind('a', 'running-round');
    await f.runtime.sessionRepository.writeDocument(bound.binding!.sessionId, 'round-running-round.json', JSON.stringify({status: 'running', output: [],
        executions: [{taskId: 'primary-task', role: 'primary'}]}));
    const release = vi.fn(async () => {}), read = vi.fn(async () => [
        {role: 'assistant', roundId: 'other-round', content: 'Unrelated response'},
        {role: 'assistant', roundId: 'running-round', executionRoot: {data: {output: 'Actual partial reply', thought: 'Private reasoning'}}},
    ]);
    const acquire = vi.fn(async () => ({commandBus: {execute: read} as never, dispose: release}));
    f.services.acquireConversation = acquire;
    expect((await f.port.get('a')).activity?.status).toBe('pending'); expect(acquire).not.toHaveBeenCalled();
    const expanded = await f.port.get('a', true);
    expect(expanded.activity).toMatchObject({status: 'pending', markdown: 'Actual partial reply'});
    expect(expanded.response?.markdown).toBe('Actual partial reply');
    expect(acquire).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    await f.runtime.sessionRepository.writeDocument(bound.binding!.sessionId, 'round-running-round.json', JSON.stringify({status: 'completed',
        output: [{role: 'assistant', content: 'Durable final reply'}]}));
    expect((await f.port.get('a', true)).activity).toMatchObject({status: 'completed', markdown: 'Durable final reply'});
    expect(acquire).toHaveBeenCalledOnce();
});
