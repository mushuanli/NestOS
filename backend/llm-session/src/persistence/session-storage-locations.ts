import { FSError, transferFileSystemEntry, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import { relocateCentralSession } from './session-storage-relocation';
import { sessionStorageRoot, storageIdentityConflict } from './session-storage-layout';

const INDEX = '/var/lib/sessions/folders.seq';
const MOVES = '/var/lib/sessions/storage-moves.seq';
type Reader = Pick<ISeqFileTransaction, 'getEntry'> & Partial<Pick<ISeqFileTransaction, 'getEntries'>>;
export async function resolveSessionStorageRoot(reader: Reader, id: string): Promise<string> {
    sessionStorageRoot(id);
    try {
        if (reader.getEntries) {
            const rows = await reader.getEntries(INDEX, [`moving/${id}`, `storage/${id}`]);
            if (rows[`moving/${id}`]) throw new FSError('EBUSY', 'Session storage relocation requires recovery');
            return rows[`storage/${id}`] ?? sessionStorageRoot(id);
        }
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
    const [sourceExists, targetExists] = await Promise.all([fs.driver.exists(from), fs.driver.exists(to)]);
    if (!await fs.driver.exists(MOVES)) {
        try { await fs.driver.createFile({ parentPath: '/var/lib/sessions', name: 'storage-moves.seq', type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
    const key = encodeURIComponent(from);
    await prepareMove(fs, key, from, to, sourceExists && targetExists);
    await finishMove(fs, key, from, to);
}
async function prepareMove(fs: IFileSystem, key: string, from: string, to: string, occupied: boolean): Promise<void> {
    await fs.meta.seq!.transaction!(async tx => {
        const pending = await tx.getEntry(MOVES, key);
        if (pending && JSON.parse(pending).to !== to) throw new FSError('EBUSY', 'Complete the pending storage move first');
        if (!pending && occupied) throw storageIdentityConflict(from.split('/').pop()!, from, to);
        await validateMoveSource(tx, from);
        if (isCentral(from)) await validateCentralMove(tx, from, to, Boolean(pending));
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
    if (isCentral(from)) {
        await fs.meta.seq!.transaction!(tx => validateCentralMove(tx, from, to, true));
        return relocateCentralSession(fs, key, from, to);
    }
    await fs.meta.seq!.transaction!(tx => validateMoveSource(tx, from));
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

async function validateCentralMove(tx: ISeqFileTransaction, from: string, to: string, pending: boolean): Promise<void> {
    const id = from.split('/').pop()!;
    const registered = await tx.getEntry(INDEX, `storage/${id}`);
    if (registered && registered !== from) throw storageIdentityConflict(id, registered, from);
    const target = await tx.getEntry(`${to}/session.seq`, 'session');
    const marker = await tx.getEntry(`${to}/session.seq`, 'storage-relocation-source');
    if (target && (!pending || marker !== from)) throw storageIdentityConflict(id, from, to);
}

async function validateMoveSource(tx: ISeqFileTransaction, from: string): Promise<void> {
    const raw = await tx.getEntry(`${from}/session.seq`, 'session');
    if (!raw) return;
    const { id } = JSON.parse(raw);
    if (id !== from.split('/').pop()) throw new FSError('ECONFLICT', 'Session move source identity mismatch', 'session-storage', from);
    const registered = await tx.getEntry(INDEX, `storage/${id}`);
    if (registered && registered !== from) throw storageIdentityConflict(id, registered, from);
}
