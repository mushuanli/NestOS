import { randomUUID } from '@itookit/common';
import { FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import { decodeIdentity, identity } from './codec';
import type { TwinIdentity } from './contracts';

const FILES = ['authority', 'knowledge', 'processing', 'indexes'] as const;
export type TwinFile = typeof FILES[number];

/** Owns layout and owner binding; knows no IndexedDB or SQLite internals. */
export class TwinSeqStorage {
    private constructor(private readonly fs: IFileSystem, private readonly root: string,
        private readonly bound: TwinIdentity) {}

    static async open(fs: IFileSystem, twinId: string, ownerId: string, progress: (stage: string) => void = () => {}): Promise<TwinSeqStorage> {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(twinId)) throw new Error('Invalid Twin path identity');
        identity(ownerId);
        if (!fs.capabilities.transactionalSeqFiles || !fs.meta.seq?.transaction) {
            throw new Error('Twin requires transactional SeqFiles');
        }
        const root = `/var/lib/digital-twin/${twinId}`;
        for (const file of FILES) { progress(`storage.prepare.${file}`); await prepare(fs, root, file); }
        const seed: TwinIdentity = { twinId, ownerId, incarnation: randomUUID(), schemaVersion: 1, layoutVersion: 6, forgetEpoch: 0 };
        progress('storage.bind-transaction');
        const bound = await fs.meta.seq.transaction(async tx => {
            const raw = await tx.getEntry(`${root}/authority.seq`, 'twin');
            const previous = raw ? JSON.parse(raw) : null;
            const upgrade = previous?.schemaVersion === 1 && [2, 3, 4, 5].includes(previous?.layoutVersion);
            const current = raw ? decodeIdentity(upgrade ? JSON.stringify({ ...previous, layoutVersion: 6 }) : raw) : seed;
            if (current.twinId !== twinId || current.ownerId !== ownerId) throw new Error('Twin owner denied');
            if (!raw) {
                await assertEmpty(tx, root);
                await tx.setEntry(`${root}/authority.seq`, 'twin', JSON.stringify(current));
            }
            // Fence older clients before any scan dispatch, preserving all identity and forget metadata.
            else if (upgrade) await tx.setEntry(`${root}/authority.seq`, 'twin', JSON.stringify(current));
            return current;
        });
        return new TwinSeqStorage(fs, root, bound);
    }

    file(name: TwinFile): string { return `${this.root}/${name}.seq`; }

    async transaction<T>(run: (tx: ISeqFileTransaction, current: TwinIdentity) => Promise<T>): Promise<T> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const current = decodeIdentity(await tx.getEntry(this.file('authority'), 'twin'));
            if (current.ownerId !== this.bound.ownerId || current.twinId !== this.bound.twinId
                || current.incarnation !== this.bound.incarnation) throw new Error('Twin binding expired');
            return run(tx, current);
        });
    }
}

async function prepare(fs: IFileSystem, root: string, file: TwinFile): Promise<void> {
    try { await fs.driver.createFile({ parentPath: root, name: `${file}.seq`, type: 'seqfile', recursive: true }); }
    catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
}

async function assertEmpty(tx: ISeqFileTransaction, root: string): Promise<void> {
    for (const file of FILES) {
        let found = false;
        await tx.walkEntries(`${root}/${file}.seq`, () => { found = true; return false; }, { limit: 1 });
        if (found) throw new Error('Twin metadata missing from nonempty storage');
    }
}
