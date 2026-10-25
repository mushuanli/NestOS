import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, type IVFSManager} from '@itookit/vfs-core';
import {sha256Hex} from '@itookit/llm-context';
import {SessionRepository} from '../src/persistence/session-repository';
import {AttachmentProcessor} from '../src/session/attachment-processor';
import {freezeAttachments, identifyRuntimeAttachments} from '../src/session/attachment-integrity';
import {createSessionHost} from '../src/utils/host-ports';
import {conversationUserMessage, materializeAttachmentMessage} from '../src/session/conversation-attachments';

let manager: IVFSManager, repository: SessionRepository, sessionId: string;
const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()}));
    repository = new SessionRepository(await manager.openFileSystem('/'));
    await repository.init(); sessionId = await repository.createSession('Attachments'); vi.clearAllMocks();
});
afterEach(async () => {await repository.dispose(); await manager.dispose();});
const bytes = (value: string) => new TextEncoder().encode(value).buffer;

it('freezes verified bytes independently of a mutable upload and preserves history identity', async () => {
    await repository.writeAttachment(sessionId, 'notes.txt', bytes('original'));
    const files = await new AttachmentProcessor(repository).resolveAttachments(sessionId, '[notes](@asset/notes.txt)', []);
    const frozen = await freezeAttachments(repository, sessionId, 'submission', files, logger);
    expect(frozen[0]).toMatchObject({content: {sha256: await sha256Hex('original'), bytes: 8}, size: 8});
    const view = await repository.openAttachments(sessionId);
    try {await view.driver.createFile({name: 'notes.txt', parentPath: '/', content: bytes('modified'), overwrite: true});}
    finally {await view.dispose();}
    const message = conversationUserMessage('Review', frozen);
    expect(message.attachments?.[0].options?.contentIdentity).toEqual(frozen[0].content);
    const materialized = await materializeAttachmentMessage(repository, sessionId, message);
    expect(materialized.attachments).toBeUndefined();
    expect(JSON.stringify(materialized.content)).toContain('original');
    expect(JSON.stringify(materialized.content)).not.toContain('modified');
});

it('rejects missing required references and declared files but allows ordinary unresolved documentation links', async () => {
    const processor = new AttachmentProcessor(repository, logger);
    await expect(processor.resolveAttachments(sessionId, '[file](@asset/missing.txt)', [])).rejects.toMatchObject({code: 'ATTACHMENT_NOT_FOUND'});
    await expect(processor.resolveAttachments(sessionId, '', [{name: 'missing.txt', type: 'text/plain'}])).rejects.toMatchObject({code: 'ATTACHMENT_NOT_FOUND'});
    expect(await processor.resolveAttachments(sessionId, '[documentation](./untracked.md)', [])).toEqual([]);
});

it('does not overwrite an attachment identity and reconciles an identical write', async () => {
    await repository.writeAttachment(sessionId, 'same.txt', bytes('first'));
    await repository.writeAttachment(sessionId, 'same.txt', bytes('first'));
    await expect(repository.writeAttachment(sessionId, 'same.txt', bytes('other'))).rejects.toMatchObject({code: 'EEXIST'});
    expect(await (await repository.readSessionAsset(sessionId, 'same.txt'))?.text()).toBe('first');
});

it('rejects a corrupted frozen attachment even when its size is unchanged', async () => {
    const [file] = await freezeAttachments(repository, sessionId, 'submit', [{name: 'a.txt', type: 'text/plain', fileRef: new Blob(['first'])}], logger);
    const view = await repository.openAttachments(sessionId);
    try {await view.driver.createFile({name: file.name, parentPath: '/', content: bytes('other'), overwrite: true});}
    finally {await view.dispose();}
    await expect(new AttachmentProcessor(repository, logger).resolveAttachments(sessionId, '', [file]))
        .rejects.toMatchObject({code: 'ATTACHMENT_CONTENT_MISMATCH'});
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('other');
});

it('reconciles a lost attachment write acknowledgement from the exact stored content', async () => {
    const original = repository.writeAttachment.bind(repository);
    vi.spyOn(repository, 'writeAttachment').mockImplementation(async (...args) => {await original(...args); throw new Error('lost ack SECRET');});
    const files = await freezeAttachments(repository, sessionId, 'lost-reply', [{name: 'a.txt', type: 'text/plain', fileRef: new Blob(['content'])}], logger);
    expect(files[0].content?.bytes).toBe(7);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('SECRET');
});

it('keeps a failed write distinct from file reading and never logs raw storage errors', async () => {
    vi.spyOn(repository, 'writeAttachment').mockRejectedValue(Object.assign(new Error('storage secret'), {code: 'ENOSPC'}));
    await expect(freezeAttachments(repository, sessionId, 'failed', [{name: 'a.txt', type: 'text/plain', fileRef: new Blob(['content'])}], logger))
        .rejects.toMatchObject({code: 'ATTACHMENT_WRITE_UNCONFIRMED'});
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({operationId: 'failed', stage: 'attachment-write', causeCode: 'ENOSPC'}));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('storage secret');
});

it('binds Blob bytes before request deduplication and rejects a forged content identity', async () => {
    const input = {name: 'same.txt', type: 'text/plain', fileRef: new Blob(['first'])};
    const [identified] = await identifyRuntimeAttachments([input]);
    expect(identified.content).toEqual({bytes: 5, sha256: await sha256Hex('first')});
    await expect(identifyRuntimeAttachments([{...input, content: {bytes: 5, sha256: await sha256Hex('other')}}]))
        .rejects.toMatchObject({code: 'ATTACHMENT_CONTENT_MISMATCH'});
});
