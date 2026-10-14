import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { ISessionRepository } from '@itookit/llm-session';
import type { DirectoryMountService } from '@itookit/app-contracts/services';
import type { SessionFilesService } from '@itookit/app-contracts/services';
import type { ProjectFavorite } from './favorites/contracts';
import type { ProjectService } from '@itookit/app-contracts/services';

const PATH = '/var/lib/projects/session-moves.seq';
interface MoveRecord { version: 1; from?: string; to: string; favorite?: ProjectFavorite; access: 'ro' | 'rw' }

/** Folder commits first; durable per-member records finish workspace and favorite migration. */
export class ProjectSessionMoves {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly root: IFileSystem, private readonly repository: ISessionRepository,
        private readonly directories: DirectoryMountService, private readonly files: SessionFilesService,
        private readonly projects: ProjectService) {}
    move(id: string, folder: string): Promise<void> {
        return this.serial(async () => {
            const target = await this.projects.forFolder(folder);
            if (!target) throw new FSError('EACCES', 'Sessions require a project destination');
            const members = await this.members(id);
            for (const member of members) await this.directories.assertWorkspaceChange(member);
            const pending = await this.read(id);
            if (pending && pending.to !== target.project.id) throw new FSError('EBUSY', 'Complete the pending Session move first');
            if (!pending) await this.prepare(members, target.project.id);
            for (const member of members) await this.files.invalidate(member);
            await this.repository.updateManifest(id, { folder, parentSessionId: null });
            for (const member of members) await this.finish(member);
        });
    }
    recover(id: string): Promise<void> { return this.serial(() => this.finish(id)); }
    /** Only called by the host after leasing the Session, before kernel recovery. */
    recoverLeased(id: string): Promise<void> { return this.serial(() => this.finish(id, true)); }
    async recoverPending(acquire: (id: string) => Promise<boolean>): Promise<void> {
        if (!await this.root.driver.exists(PATH)) return;
        const ids: string[] = [];
        await this.root.meta.seq!.walkEntries(PATH, entry => { ids.push(entry.key); return true; });
        for (const id of ids) if (await acquire(id)) await this.recoverLeased(id);
    }
    async ready(id: string): Promise<boolean> { return !await this.read(id); }
    private async members(id: string): Promise<string[]> {
        const sessions = await this.repository.list(), members = new Set([id]);
        if (!sessions.some(item => item.id === id)) throw new FSError('ENOENT', 'Session not found');
        for (let size = -1; size !== members.size;) {
            size = members.size;
            for (const item of sessions) if (item.parentSessionId && members.has(item.parentSessionId)) members.add(item.id);
        }
        return [...members];
    }
    private async prepare(ids: string[], to: string): Promise<void> {
        const records = new Map<string, MoveRecord>();
        for (const id of ids) {
            const existing = await this.read(id);
            if (existing) throw new FSError('EBUSY', 'Session has a pending move');
            const project = await this.projects.forFolder((await this.repository.getManifest(id)).folder);
            const favorite = project && (await this.projects.favorites.list(project.project.id))
                .find(item => item.target.kind === 'session' && item.target.sessionId === id);
            const primary = (await this.files.inspect(id))?.mounts.find(mount => mount.at === '/workspace');
            records.set(id, { version: 1, from: project?.project.id, to, favorite, access: primary?.access ?? 'rw' });
        }
        if (!await this.root.driver.exists(PATH)) {
            try { await this.root.driver.createFile({ parentPath: '/var/lib/projects', name: 'session-moves.seq', type: 'seqfile', recursive: true }); }
            catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
        }
        await this.root.meta.seq!.transaction!(async tx => {
            for (const [id, record] of records) {
                if (await tx.getEntry(PATH, id)) throw new FSError('EBUSY', 'Session has a pending move');
                await tx.setEntry(PATH, id, JSON.stringify(record));
            }
        });
    }
    private async finish(id: string, recovering = false): Promise<void> {
        const record = await this.read(id); if (!record) return;
        const manifest = await this.repository.getManifest(id);
        const project = await this.projects.forFolder(manifest.folder);
        if (project?.project.id === record.to) {
            await this.repository.relocateProjectStorage?.(id);
            const access = this.projects.workspaceAccess(project, record.access);
            if (recovering) await this.directories.restoreWorkspace(id, project.project.directory, access);
            else await this.directories.setWorkspace(id, project.project.directory, access);
            if (record.favorite && record.from !== record.to) {
                await this.projects.favorites.include(record.to, [{ ...record.favorite, title: manifest.title }]);
                if (record.from) await this.projects.favorites.remove(record.from, record.favorite.id);
            }
        }
        await this.root.meta.seq!.deleteEntry(PATH, id);
        await this.files.invalidate(id);
    }
    private async read(id: string): Promise<MoveRecord | undefined> {
        if (!await this.root.driver.exists(PATH)) return undefined;
        const raw = await this.root.meta.seq!.getEntry(PATH, id);
        if (!raw) return undefined;
        const record: MoveRecord = JSON.parse(raw);
        if (record.version !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.to)
            || !['ro', 'rw'].includes(record.access)
            || record.favorite && (record.favorite.target.kind !== 'session' || record.favorite.target.sessionId !== id)) {
            throw new FSError('EIO', 'Invalid Session move recovery record');
        }
        return record;
    }
    private serial<T>(run: () => Promise<T>): Promise<T> {
        const result = this.tail.catch(() => {}).then(run); this.tail = result; return result;
    }
}
