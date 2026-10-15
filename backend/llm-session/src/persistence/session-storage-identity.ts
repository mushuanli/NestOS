import { FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import { sessionStorageRoot, storageIdentityConflict } from './session-storage-layout';
import { resolveSessionStorageRoot } from './session-storage-locations';
import type { SessionSummary } from './types';

const INDEX = '/var/lib/sessions/folders.seq';
type Location = { name: string; path: string };

export async function assertSessionStorageLocation(tx: ISeqFileTransaction, id: string, path: string): Promise<void> {
    const registered = await resolveSessionStorageRoot(tx, id);
    if (registered !== path) throw storageIdentityConflict(id, registered, path);
}

/** Reserve identity before creating files; legacy central data keeps its existing ownership. */
export async function reserveSessionStorage(fs: IFileSystem, id: string, candidate: string, createOnly: boolean): Promise<void> {
    const central = sessionStorageRoot(id);
    const centralExists = await fs.driver.exists(`${central}/session.seq`);
    await fs.meta.seq!.transaction!(async tx => {
        const registered = await tx.getEntry(INDEX, `storage/${id}`);
        if (await tx.getEntry(INDEX, `moving/${id}`)) throw new FSError('EBUSY', 'Session storage relocation requires recovery');
        const rows = await tx.getEntriesMany([central, candidate, registered ?? candidate].map(path => ({ fileIdOrPath: `${path}/session.seq`, key: 'session' })));
        const centralManifest = centralExists ? rows[0] : null;
        const path = registered ?? (centralManifest ? central : candidate);
        if (centralManifest && candidate !== central && rows[1] && !registered)
            throw storageIdentityConflict(id, central, candidate);
        if (createOnly && (centralManifest || rows[1] || rows[2] || registered))
            throw new FSError('EEXIST', `Session identity already exists: ${id}`, 'create', path);
        if (!registered) await tx.setEntry(INDEX, `storage/${id}`, path);
    });
}

/** Validate the whole batch before publishing any navigation or storage record. */
export async function validateProjectSessionStorage(tx: ISeqFileTransaction, children: readonly Location[],
    sessions: readonly (SessionSummary | null)[], stored?: Record<string, string>): Promise<void> {
    const locations = stored ?? await tx.getEntries(INDEX, children.flatMap(child => [`storage/${child.name}`, `moving/${child.name}`]));
    const candidates = children.flatMap((child, index) => sessions[index] ? [{ child, session: sessions[index]! }] : []);
    for (const { child, session } of candidates) {
        if (!/^[a-zA-Z0-9_-]+$/.test(child.name) || session.id !== child.name)
            throw new FSError('ECONFLICT', `Session directory identity mismatch: ${child.name}; manifest=${session.id}`, 'session-storage', child.path);
    }
    const central = await tx.getEntriesMany(candidates.map(({ child }) => ({ fileIdOrPath: `${sessionStorageRoot(child.name)}/session.seq`, key: 'session' })));
    for (const [index, { child }] of candidates.entries()) {
        const registered = locations[`storage/${child.name}`];
        if (registered && registered !== child.path) throw storageIdentityConflict(child.name, registered, child.path);
        if (!registered && child.path !== sessionStorageRoot(child.name)
            && central[index])
            throw storageIdentityConflict(child.name, sessionStorageRoot(child.name), child.path);
        if (locations[`moving/${child.name}`])
            throw new FSError('EBUSY', `Session storage relocation requires recovery: ${child.name}`, 'session-storage', child.path);
    }
}
