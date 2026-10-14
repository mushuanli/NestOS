import { moveSessionDataDirectory } from '@itookit/llm-session';
import { FSError, type IFileSystem, type FileSystemSourceOwner } from '@itookit/vfs-core';
import type { DirectoryMountService } from '@itookit/app-contracts/services';
import { mapConcurrent } from '../utils/map-concurrent';

const ROOT = '/home/admin/projects';
const INFO = '/.mindos/info.seq';
const READONLY = `${ROOT}/.mindos/readonly`;
const EXTERNAL = `${ROOT}/.mindos/local.seq`;
export interface ProjectIdentity { version: 1; id: string; name: string; createdAt: number; navigationName?: string }
export interface StoredProject extends ProjectIdentity { directory: string; kind: 'local' | 'remote'; metadataDirectory?: string }

/** Local identity lives with its directory; remote records are explicit workbench references. */
export class ProjectRepository {
    private unsubscribe?: () => void;
    constructor(private readonly root: IFileSystem, private readonly directories: DirectoryMountService) {
        this.unsubscribe = root.onAny?.(event => {
            const payload = event.payload as { paths?: string[]; requestedPaths?: string[]; nodes?: Array<{path?: string; oldPath?: string; newPath?: string}> };
            const paths = [...(payload.paths ?? []), ...(payload.requestedPaths ?? []),
                ...(payload.nodes ?? []).flatMap(node => [node.path, node.oldPath, node.newPath].filter((path): path is string => !!path))];
            if (paths.some(path => this.affectsIdentity(path))) this.invalidate();
        });
    }
    dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.invalidate(); }
    private affectsIdentity(path: string): boolean {
        if (path.endsWith('/.mindos/info.seq') || path === EXTERNAL || path.endsWith('/info.seq') && path.startsWith(READONLY + '/')) return true;
        return path === ROOT || path.startsWith(ROOT + '/') && !path.slice(ROOT.length + 1).includes('/');
    }
    private snapshot?: { until: number; rows: StoredProject[] };
    private pending?: Promise<StoredProject[]>;
    private revision = 0;
    invalidate(): void { this.revision++; this.snapshot = undefined; this.pending = undefined; }
    async list(): Promise<StoredProject[]> {
        if (this.snapshot && this.snapshot.until > Date.now()) return structuredClone(this.snapshot.rows);
        if (!this.pending) {
            const revision = this.revision;
            const work = this.scan().then(rows => {
                if (revision === this.revision) this.snapshot = { until: Date.now() + 30_000, rows };
                return rows;
            });
            this.pending = work;
            void work.finally(() => { if (this.pending === work) this.pending = undefined; }).catch(() => {});
        }
        return structuredClone(await this.pending);
    }
    private async scan(): Promise<StoredProject[]> {
        const records: StoredProject[] = [];
        const children = await this.root.driver.getChildren(ROOT).catch(error => {
            if (error instanceof FSError && error.code === 'ENOENT') return [];
            throw error;
        });
        const local = await mapConcurrent(children.filter(child => child.type === 'directory' && child.name !== '.mindos'),
            4, child => this.readLocal(child.path));
        records.push(...local.filter((project): project is StoredProject => project !== undefined));
        const external = await mapConcurrent(await this.references(EXTERNAL), 4, async reference => {
            const project = await this.readLocal(reference.directory);
            return project?.id === reference.id ? project : undefined;
        });
        records.push(...external.filter((project): project is StoredProject => project !== undefined));
        if (await this.root.driver.exists(READONLY)) {
            const remote = await mapConcurrent((await this.root.driver.getChildren(READONLY)).filter(child => child.type === 'directory'),
                4, child => this.readRemote(child.path));
            records.push(...remote.filter((project): project is StoredProject => project !== undefined));
        }
        const ids = new Set<string>();
        for (const record of records) {
            if (ids.has(record.id)) throw new FSError('ECONFLICT', 'Duplicate project identity');
            ids.add(record.id);
        }
        return records;
    }
    private async readRemote(directory: string): Promise<StoredProject | undefined> {
        const path = `${directory}/info.seq`;
        if (!await this.root.driver.exists(path)) return undefined;
        const raw = await this.root.meta.seq!.getEntry(path, 'identity');
        if (!raw) return undefined;
        const identity = this.decode(raw);
        return { ...identity, directory: `project:${identity.id}`, kind: 'remote', metadataDirectory: directory };
    }
    async createLocal(directory: string, identity: ProjectIdentity): Promise<void> {
        this.invalidate();
        const owner = await this.directories.openDirectory(directory);
        try { await this.writeIdentity(owner.fs, identity, false); }
        finally { this.invalidate(); await owner.dispose(); }
        if (!directory.startsWith(ROOT + '/') || directory.slice(ROOT.length + 1).includes('/'))
            await this.saveReference(EXTERNAL, { ...identity, directory, kind: 'local' });
    }
    async adoptLocal(directory: string, identity: ProjectIdentity): Promise<void> {
        this.invalidate();
        const owner = await this.directories.inspectDirectory(directory);
        try { await this.writeIdentity(owner.fs, identity, true); }
        finally { this.invalidate(); await owner.dispose(); }
        if (!directory.startsWith(ROOT + '/') || directory.slice(ROOT.length + 1).includes('/'))
            await this.saveReference(EXTERNAL, { ...identity, directory, kind: 'local' });
    }
    private async writeIdentity(fs: IFileSystem, identity: ProjectIdentity, adopt: boolean): Promise<void> {
        const seq = fs.meta.seq;
        if (!seq?.transaction) throw new FSError('ECAPABILITY', 'Project identity requires SeqFile transactions');
        if (!await fs.driver.exists(INFO)) {
            try { await fs.driver.createFile({ parentPath: '/.mindos', name: 'info.seq', type: 'seqfile', recursive: true }); }
            catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
        }
        await seq.transaction(async tx => {
            const existing = await tx.getEntry(INFO, 'identity');
            if (existing && (!adopt || this.decode(existing).id !== identity.id)) {
                throw new FSError(adopt ? 'ECONFLICT' : 'EEXIST', 'Directory already contains a project identity');
            }
            if (!existing) await tx.setEntry(INFO, 'identity', JSON.stringify(identity));
        });
    }
    async createRemote(identity: ProjectIdentity): Promise<void> {
        this.invalidate();
        const directory = identity.navigationName ?? identity.name;
        const path = `${READONLY}/${directory}/info.seq`;
        if (!await this.root.driver.exists(path)) await this.root.driver.createFile({ parentPath: `${READONLY}/${directory}`, name: 'info.seq', type: 'seqfile', recursive: true });
        const existing = await this.root.meta.seq!.getEntry(path, 'identity');
        if (existing && this.decode(existing).id !== identity.id) throw new FSError('EEXIST', 'Readonly project already exists');
        await this.root.meta.seq!.setEntry(path, 'identity', JSON.stringify(identity));
    }
    async rename(project: StoredProject, name: string, navigationName?: string): Promise<void> {
        this.invalidate();
        const identity: ProjectIdentity = { version:1,id:project.id,name,createdAt:project.createdAt,...(navigationName ? {navigationName} : {}) };
        if (project.kind === 'remote') {
            await moveSessionDataDirectory(this.root, project.metadataDirectory!, `${READONLY}/${navigationName ?? name}`);
            await this.root.meta.seq!.setEntry(`${READONLY}/${navigationName ?? name}/info.seq`, 'identity', JSON.stringify(identity));
            return;
        }
        const owner = await this.directories.openDirectory(project.directory);
        try { await owner.fs.meta.seq!.setEntry(INFO, 'identity', JSON.stringify(identity)); }
        finally { this.invalidate(); await owner.dispose(); }
    }
    async remove(project: StoredProject): Promise<void> {
        this.invalidate();
        if (project.kind === 'remote') {
            const path = `${project.metadataDirectory}/info.seq`;
            await this.root.meta.seq!.deleteEntry(path, 'identity');
            await this.root.driver.delete([project.metadataDirectory!], { recursive: true }); return;
        }
        const owner = await this.directories.openDirectory(project.directory);
        try {
            await owner.fs.meta.seq!.deleteEntry(INFO, 'identity');
            await owner.fs.driver.delete([INFO]);
        } finally { this.invalidate(); await owner.dispose(); }
        if (await this.root.driver.exists(EXTERNAL)) await this.root.meta.seq!.deleteEntry(EXTERNAL, project.id);
        if (project.directory.startsWith(ROOT + '/')) await this.root.driver.delete([project.directory], { recursive: true });
    }
    sessionDirectory(project: StoredProject): string {
        if (project.kind === 'remote') return `${project.metadataDirectory}/sessions`;
        return project.directory.startsWith('/home/admin/') ? `${project.directory}/.mindos/sessions`
            : `${ROOT}/.mindos/local/${project.id}/sessions`;
    }
    private async readLocal(directory: string): Promise<StoredProject | undefined> {
        let owner: FileSystemSourceOwner | undefined;
        try {
            owner = await this.directories.inspectDirectory(directory);
            if (!await owner.fs.driver.exists(INFO)) return undefined;
            const raw = await owner.fs.meta.seq?.getEntry(INFO, 'identity');
            if (!raw) return undefined;
            return { ...this.decode(raw), directory, kind: 'local' };
        } catch (error) {
            if (error instanceof FSError && error.code === 'ENOENT') return undefined;
            throw error;
        } finally { await owner?.dispose(); }
    }
    private decode(raw: string): ProjectIdentity {
        const identity = JSON.parse(raw) as ProjectIdentity;
        if (identity.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(identity.id) || !identity.name?.trim()
            || /[/\\\0]/.test(identity.name) || (identity.navigationName !== undefined && (typeof identity.navigationName !== 'string' || !identity.navigationName || /[/\\\0]/.test(identity.navigationName))) || !Number.isFinite(identity.createdAt)) throw new FSError('EINVAL', 'Invalid project identity');
        return identity;
    }
    private async references(path: string): Promise<StoredProject[]> {
        if (!await this.root.driver.exists(path)) return [];
        const records: StoredProject[] = [];
        await this.root.meta.seq!.walkEntries(path, entry => {
            const reference = JSON.parse(entry.value) as StoredProject;
            this.decode(entry.value);
            if (reference.id !== entry.key || !reference.directory || !['local', 'remote'].includes(reference.kind))
                throw new FSError('EINVAL', 'Invalid project reference');
            records.push(reference); return true;
        });
        return records;
    }
    private async saveReference(path: string, project: StoredProject): Promise<void> {
        if (!await this.root.driver.exists(path)) {
            try { await this.root.driver.createFile({ parentPath: `${ROOT}/.mindos`, name: path.split('/').pop()!, type: 'seqfile', recursive: true }); }
            catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
        }
        await this.root.meta.seq!.setEntry(path, project.id, JSON.stringify(project));
    }
}
