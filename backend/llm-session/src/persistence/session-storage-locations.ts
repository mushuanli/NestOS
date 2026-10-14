import { FSError, transferFileSystemEntry, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import { relocateCentralSession } from './session-storage-relocation';
import { sessionStorageRoot } from './session-storage-layout';

const INDEX = '/var/lib/sessions/folders.seq';
const MOVES = '/var/lib/sessions/storage-moves.seq';
type Reader = Pick<ISeqFileTransaction, 'getEntry'>;
export async function resolveSessionStorageRoot(reader: Reader, id: string): Promise<string> {
    sessionStorageRoot(id);
    try {
        if (await reader.getEntry(INDEX, `moving/${id}`)) throw new FSError('EBUSY', 'Session storage relocation requires recovery');
        return await reader.getEntry(INDEX, `storage/${id}`) ?? sessionStorageRoot(id);
    } catch (error) {
        if (error instanceof FSError && error.code === 'ENOENT') return sessionStorageRoot(id);
        throw error;
    }
}

/** Persist intent before a same-backend directory move; index publication is transactional. */
export async function moveSessionDataDirectory(fs: IFileSystem, from: string, to: string): Promise<void> {
    if (from === to) return;
    validateMove(from, to);
    if (!await fs.driver.exists(MOVES)) {
        try { await fs.driver.createFile({ parentPath: '/var/lib/sessions', name: 'storage-moves.seq', type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
    const key = encodeURIComponent(from);
    await fs.meta.seq!.transaction!(async tx => {
        const pending = await tx.getEntry(MOVES, key);
        if (pending && JSON.parse(pending).to !== to) throw new FSError('EBUSY', 'Complete the pending storage move first');
        if (!pending) await tx.setEntry(MOVES, key, JSON.stringify({ from, to }));
        if (isCentral(from)) {
            const id = from.split('/').pop()!;
            await tx.setEntry(INDEX, `storage/${id}`, from);
            await tx.setEntry(INDEX, `moving/${id}`, key);
        }
        await tx.walkEntries(INDEX, async entry => {
            if (entry.value === from || entry.value.startsWith(from + '/')) await tx.setEntry(INDEX, `moving/${entry.key.slice(8)}`, key);
            return true;
        }, { keyPrefix: 'storage/' });
    });
    await finishMove(fs, key, from, to);
}
export async function recoverSessionDataMoves(fs: IFileSystem): Promise<void> {
    if (!await fs.driver.exists(MOVES)) return;
    const pending: Array<{ key: string; from: string; to: string }> = [];
    await fs.meta.seq!.walkEntries(MOVES, entry => { pending.push({ key: entry.key, ...JSON.parse(entry.value) }); return true; });
    for (const move of pending) {
        try { await finishMove(fs, move.key, move.from, move.to); }
        catch (error) {
            // Preserve the intent and block only affected identities until explicit repair.
            console.warn('[Session storage] Recovery deferred', { from: move.from, to: move.to, cause: error });
        }
    }
}
async function finishMove(fs: IFileSystem, key: string, from: string, to: string): Promise<void> {
    validateMove(from, to);
    if (isCentral(from)) return relocateCentralSession(fs, key, from, to);
    const [source, target] = await Promise.all([fs.driver.exists(from), fs.driver.exists(to)]);
    if (source && target) throw new FSError('ECONFLICT', 'Both Session storage locations exist');
    if (!source && !target) throw new FSError('ENOENT', 'Session storage relocation contents missing');
    if (source) {
        const parent = to.slice(0, to.lastIndexOf('/'));
        if (!await fs.driver.exists(parent)) await fs.driver.createDirectory({ parentPath: parent.slice(0, parent.lastIndexOf('/')), name: parent.split('/').pop()!, recursive: true });
        await transferFileSystemEntry(fs, from, fs, parent, { move: true, newName: to.split('/').pop() });
    }
    await fs.meta.seq!.transaction!(async tx => {
        await tx.walkEntries(INDEX, async entry => {
            if (entry.value === from || entry.value.startsWith(from + '/')) {
                await tx.setEntry(INDEX, entry.key, to + entry.value.slice(from.length));
                await tx.deleteEntry(INDEX, `moving/${entry.key.slice(8)}`);
            }
            return true;
        }, { keyPrefix: 'storage/' });
        await tx.deleteEntry(MOVES, key);
    });
}

function isCentral(path: string): boolean { return /^\/var\/lib\/sessions\/[a-zA-Z0-9_-]+$/.test(path); }
function validateMove(from: string, to: string): void {
    const canonical = (path: string) => path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
        && path.slice(1).split('/').every(part => !!part && part !== '.' && part !== '..');
    if ((!from.startsWith('/home/admin/') && !isCentral(from)) || !to.startsWith('/home/admin/')
        || !canonical(from) || !canonical(to) || to.startsWith(from + '/') || from.startsWith(to + '/')
        || (isCentral(from) && from.split('/').pop() !== to.split('/').pop()))
        throw new FSError('EINVAL', 'Invalid Session storage relocation', 'relocate', from);
}
