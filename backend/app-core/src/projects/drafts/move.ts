import {createModuleLogger, randomUUID, sha256HexSync, t} from '@itookit/common';
import {FSError, type IFileSystem} from '@itookit/vfs-core';
import {decodeDraftRecord, emptyDraft} from './record-codec';
import type {ProjectDraftRecord} from './contracts';

const log = createModuleLogger('project-draft');
const pathOf = (project: string) => `/var/lib/projects/${project}/draft.seq`;
const moveKey = (draft: ProjectDraftRecord) => `move/${draft.id}/${draft.attachmentScopeId ?? draft.id}`;
const filesOf = (project: string, draft: string) => `/var/lib/projects/${project}/draft-attachments/${draft}`;

/** Copy immutable assets first, then atomically move the sole ownership record. */
export async function moveProjectDraft(fs: IFileSystem, source: string, target: string, expected: ProjectDraftRecord): Promise<void> {
    const operationId = randomUUID(), started = Date.now(); let stage = 'validate';
    try {
        if (source === target) return;
        if (expected.state !== 'draft') throw new FSError('EBUSY', t('project.draftProjectLocked'));
        if (await moved(fs, source, target, expected)) return;
        const targetRaw = await fs.meta.seq!.getEntry(pathOf(target), 'draft');
        const destination = decodeDraftRecord(targetRaw).record;
        if (destination.state !== 'draft' || destination.data) throw new FSError('EBUSY', t('project.draftTargetOccupied'));
        stage = 'stage-assets';
        const incoming = {...expected, attachmentScopeId: destination.attachmentScopeId ?? destination.id};
        await copyFiles(fs, filesOf(source, expected.attachmentScopeId ?? expected.id), filesOf(target, incoming.attachmentScopeId));
        stage = 'commit';
        const committed = await commitMove(fs, source, target, expected, incoming, targetRaw);
        stage = 'cleanup';
        if (!committed) await moved(fs, source, target, expected);
        if (committed) await removeFiles(fs, filesOf(source, expected.attachmentScopeId ?? expected.id), operationId);
        log.info('draft.move', {operationId, stage: 'complete', result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        try {if (await moved(fs, source, target, expected)) return;}
        catch {log.warn('draft.move', {operationId, stage: 'receipt', result: 'failure', code: 'DRAFT_MOVE_RECEIPT_CHANGED', durationMs: Date.now() - started});}
        log.warn('draft.move', {operationId, stage, result: 'failure', code: error instanceof FSError ? error.code : 'DRAFT_MOVE_FAILED',
            durationMs: Date.now() - started});
        throw error;
    }
}
async function moved(fs: IFileSystem, source: string, target: string, draft: ProjectDraftRecord): Promise<boolean> {
    const raw = await fs.meta.seq!.getEntry(pathOf(source), moveKey(draft));
    if (!raw) return false;
    if (JSON.parse(raw).projectId !== target) throw new FSError('ECONFLICT', t('project.draftProjectChanged'));
    const current = decodeDraftRecord(await fs.meta.seq!.getEntry(pathOf(target), 'draft')).record;
    if (current.id !== draft.id || current.attachmentScopeId !== JSON.parse(raw).attachmentScopeId || current.state !== 'draft') throw new FSError('ECONFLICT', t('project.draftProjectChanged'));
    return true;
}
async function commitMove(fs: IFileSystem, source: string, target: string, expected: ProjectDraftRecord, incoming: ProjectDraftRecord, targetRaw: string | null) {
    return fs.meta.seq!.transaction!(async tx => {
        const receipt = await tx.getEntry(pathOf(source), moveKey(expected));
        if (receipt) {
            if (JSON.parse(receipt).projectId !== target) throw new FSError('ECONFLICT', t('project.draftProjectChanged'));
            return false;
        }
        const raw = await tx.getEntry(pathOf(source), 'draft'), current = decodeDraftRecord(raw).record;
        if (current.id !== expected.id || current.attachmentScopeId !== expected.attachmentScopeId || current.state !== 'draft' || current.data !== expected.data)
            throw new FSError('ECONFLICT', t('project.draftProjectChanged'));
        if (!await tx.compareAndSet(pathOf(target), 'draft', {expected: targetRaw, value: JSON.stringify(incoming)})
            || !await tx.compareAndSet(pathOf(source), 'draft', {expected: raw, value: JSON.stringify(emptyDraft())}))
            throw new FSError('ECONFLICT', t('project.draftProjectChanged'));
        await tx.setEntry(pathOf(source), moveKey(expected), JSON.stringify({projectId: target, attachmentScopeId: incoming.attachmentScopeId}));
        return true;
    });
}
async function copyFiles(fs: IFileSystem, from: string, to: string): Promise<void> {
    if (!await fs.driver.exists(from)) return;
    for (const file of await fs.driver.getChildren(from)) {
        if (file.type === 'directory' || !/^[a-zA-Z0-9_-]+$/.test(file.name)) throw new FSError('EINVAL', 'Invalid draft attachment');
        const bytes = await fs.driver.readContent(file.path, {encoding: 'binary'});
        if (await fs.driver.exists(`${to}/${file.name}`)) {
            const previous = await fs.driver.readContent(`${to}/${file.name}`, {encoding: 'binary'});
            if (sha256HexSync(new Uint8Array(previous)) !== sha256HexSync(new Uint8Array(bytes))) throw new FSError('ECONFLICT', 'Draft attachment changed');
        } else await fs.driver.createFile({parentPath: to, name: file.name, content: bytes, recursive: true});
    }
}
async function removeFiles(fs: IFileSystem, path: string, operationId: string): Promise<void> {
    const started = Date.now();
    try {if (await fs.driver.exists(path)) await fs.driver.delete([path], {recursive: true});}
    catch (error) {log.warn('draft.move', {operationId, durationMs: Date.now() - started, stage: 'cleanup', result: 'failure', code: error instanceof FSError ? error.code : 'DRAFT_ASSET_CLEANUP_FAILED'});}
}
