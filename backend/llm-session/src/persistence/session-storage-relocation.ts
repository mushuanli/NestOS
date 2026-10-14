import { copySessionAttachments } from './session-attachment-copy';
import { FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';

const INDEX = '/var/lib/sessions/folders.seq';
const MOVES = '/var/lib/sessions/storage-moves.seq';
const MARKER = 'storage-relocation-source';

/** Only portable records move out of the shared runtime directory. */
export async function relocateCentralSession(fs: IFileSystem, key: string, from: string, to: string): Promise<void> {
    const id = from.split('/').pop()!;
    const manifest = await fs.meta.seq!.getEntry(`${from}/session.seq`, 'session');
    if (manifest === null) throw new FSError('ENOENT', 'Session relocation source identity missing');
    if (JSON.parse(manifest).id !== id) throw new FSError('ECONFLICT', 'Session relocation source identity mismatch');
    if (to.split('/').pop() !== id) throw new FSError('EINVAL', 'Session relocation identity mismatch');
    await prepareTarget(fs, from, to);
    const pending = JSON.parse((await fs.meta.seq!.getEntry(MOVES, key))!);
    await copySessionAttachments(fs, `${from}/attachments`, `${to}/attachments`);
    await fs.meta.seq!.setEntry(MOVES, key, JSON.stringify({ ...pending, attachmentsCopied: true }));
    await fs.meta.seq!.transaction!(async tx => {
        for (const name of ['session', 'settings']) {
            const value = await tx.getEntry(`${from}/session.seq`, name);
            if (value !== null) await tx.setEntry(`${to}/session.seq`, name, value);
        }
        await copyHistory(tx, from, to);
        await tx.setEntry(INDEX, `storage/${id}`, to);
        await tx.deleteEntry(INDEX, `moving/${id}`);
        for (const name of ['session', 'settings']) await tx.deleteEntry(`${from}/session.seq`, name);
        await tx.deleteEntry(`${to}/session.seq`, MARKER);
        await tx.deleteEntry(MOVES, key);
    });
}

async function prepareTarget(fs: IFileSystem, from: string, to: string): Promise<void> {
    if (await fs.driver.exists(to)) {
        if (await fs.meta.seq!.getEntry(`${to}/session.seq`, MARKER) !== from)
            throw new FSError('ECONFLICT', 'Session relocation target already exists');
    } else {
        await fs.driver.createFile({ parentPath: to, name: 'session.seq', type: 'seqfile', recursive: true });
        await fs.meta.seq!.setEntry(`${to}/session.seq`, MARKER, from);
    }
    if (!await fs.driver.exists(`${to}/history.seq`))
        await fs.driver.createFile({ parentPath: to, name: 'history.seq', type: 'seqfile' });
}

async function copyHistory(tx: ISeqFileTransaction, from: string, to: string): Promise<void> {
    await tx.walkEntries(`${from}/history.seq`, async entry => {
        await tx.setEntry(`${to}/history.seq`, entry.key, entry.value); return true;
    });
}
