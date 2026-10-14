import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { SessionFilesService, SessionMountRecord } from './session-files';
import { acquireSessionProcessContext, type SessionProcessFactory, type SessionProcessMount } from './session-process-context';
import { createVFSToolContext } from './tool-context';

/** The host verifies that this source and native path identify the same isolated copy. */
export interface WorkspaceProcessSource { mountId: string; fs: IFileSystem; directory: string; access?: 'ro' | 'rw'; }

/** Acquire file and process views from one authorization revision without changing Session grants. */
export async function acquireWorkspaceProcessContext(files: SessionFilesService, sessionId: string,
    source: WorkspaceProcessSource, factory: SessionProcessFactory,
    processMounts: () => Promise<SessionProcessMount[]>) {
    const access = source.access ?? 'rw';
    const owner = await files.acquireWorkspaceFiles(sessionId, source.mountId, source.fs, access);
    const revision = owner.context.fs.revision;
    let acquired: Awaited<ReturnType<typeof acquireSessionProcessContext>> | undefined;
    try {
        const mount = await currentMount(files, sessionId, source.mountId, revision, access);
        const mounts = replaceProcessMount(await processMounts(), mount, source.directory, access);
        acquired = await acquireSessionProcessContext({ acquire: async () => ({
            cwd: owner.context.cwd, vfs: createVFSToolContext(owner.context), release: owner.release,
        }) }, sessionId, factory, async () => mounts);
        await currentMount(files, sessionId, source.mountId, revision, access);
        return acquired;
    } catch (error) {
        try { await (acquired ?? owner).release(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Workspace acquisition and cleanup failed'); }
        throw error;
    }
}

async function currentMount(files: SessionFilesService, sessionId: string, mountId: string, revision: number, access: 'ro' | 'rw'): Promise<SessionMountRecord> {
    const record = await files.inspect(sessionId);
    const mount = record?.mounts.find(item => item.mountId === mountId);
    if (record?.state !== 'active' || record.revision !== revision || !mount || (access === 'rw' && mount.access !== 'rw')) {
        throw new FSError('ECONFLICT', 'Workspace authorization changed during acquisition');
    }
    return mount;
}

function replaceProcessMount(mounts: SessionProcessMount[], selected: SessionMountRecord, directory: string, access: 'ro' | 'rw'): SessionProcessMount[] {
    const matching = mounts.filter(mount => mount.at === selected.at);
    if (matching.length !== 1 || matching[0].sourceId !== selected.sourceId || matching[0].access !== selected.access) {
        throw new FSError('EACCES', 'Workspace process grant does not match the file grant');
    }
    // A host path must not retain admin-home's virtual-path translation in the Tauri factory.
    return mounts.map(mount => access === 'ro' ? { ...mount, access } : mount).map(mount => mount.at === selected.at
        ? { ...mount, sourceId: 'flow-workspace', directory } : { ...mount });
}
