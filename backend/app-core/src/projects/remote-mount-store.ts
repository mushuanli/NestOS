import { FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import type { ProjectRemoteMount } from './remote-mounts';
import type { RemoteFileSystemConfig } from './remote-connections';

export interface RemoteMountCatalog {
    version: 1; revision: number; projects: Record<string, ProjectRemoteMount[]>; connections?: RemoteFileSystemConfig[];
}
interface Index { version: 1; revision: number; connections: string[]; projects: string[]; }
const indexPath = '/etc/fs/catalog.seq';
const legacyPath = '/etc/project-remote-mounts.seq';
const key = 'config';

/** The small index and changed records commit together; empty files from interrupted preparation are harmless. */
export class RemoteMountStore {
    private indexRaw: string | null = null;
    private legacyRaw: string | null = null;
    private passwords = new Map<string, string | null>();
    private records = new Map<string, string | null>();
    constructor(private readonly fs: IFileSystem) {}
    password(id: string): string | null { return this.passwords.get(recordPath('remote', id)) ?? null; }
    get needsMigration(): boolean { return this.indexRaw === null && this.legacyRaw !== null; }
    async load(): Promise<RemoteMountCatalog | null> {
        if (await this.fs.driver.exists(indexPath)) {
            const saved = await this.transaction(async tx => {
                this.indexRaw = await tx.getEntry(indexPath, 'index');
                if (this.indexRaw === null) return null;
                const index = parse(this.indexRaw) as Index;
                if (!index || index.version !== 1 || !Number.isSafeInteger(index.revision) || index.revision < 0
                    || !Array.isArray(index.connections) || !Array.isArray(index.projects)) throw invalid();
                const paths = [...index.connections.map(id => recordPath('remote', id)), ...index.projects.map(id => recordPath('projects', id))];
                const values = await tx.getEntriesMany(paths.map(fileIdOrPath => ({ fileIdOrPath, key })));
                this.records = new Map(paths.map((path, i) => [path, values[i]]));
                const passwordPaths = index.connections.map(id => recordPath('remote', id));
                const passwords = await tx.getEntriesMany(passwordPaths.map(fileIdOrPath => ({ fileIdOrPath, key: 'password' })));
                this.passwords = new Map(passwordPaths.map((path, i) => [path, passwords[i]]));
                return { version: 1 as const, revision: index.revision,
                    connections: index.connections.map((id, i) => { const value = tolerant(values[i]) as RemoteFileSystemConfig; return value?.id === id ? value : null; }) as RemoteFileSystemConfig[],
                    projects: Object.fromEntries(index.projects.map((id, i) => [id, tolerant(values[index.connections.length + i])])) as Record<string, ProjectRemoteMount[]> };
            });
            if (saved) return saved;
        }
        if (!await this.fs.driver.exists(legacyPath)) return null;
        this.legacyRaw = await this.fs.meta.seq!.getEntry(legacyPath, 'catalog');
        return this.legacyRaw === null ? null : parse(this.legacyRaw) as RemoteMountCatalog;
    }
    async save(catalog: RemoteMountCatalog, credential?: { id: string; password: string }): Promise<void> {
        const records = new Map<string, string>();
        for (const connection of catalog.connections ?? []) records.set(recordPath('remote', connection.id), JSON.stringify(connection));
        for (const [id, mounts] of Object.entries(catalog.projects)) records.set(recordPath('projects', id), JSON.stringify(mounts));
        const index: Index = { version: 1, revision: catalog.revision, connections: (catalog.connections ?? []).map(item => item.id), projects: Object.keys(catalog.projects) };
        const passwords = new Map((catalog.connections ?? []).map(item => {
            const path = recordPath('remote', item.id);
            return [path, credential?.id === item.id ? credential.password : this.passwords.get(path) ?? null] as const;
        }));
        const raw = JSON.stringify(index);
        await this.ensureFile(indexPath);
        for (const path of records.keys()) if (!this.records.has(path)) await this.ensureFile(path);
        await this.transaction(async tx => {
            if (!await tx.compareAndSet(indexPath, 'index', { expected: this.indexRaw, value: raw })) throw conflict();
            if (this.needsMigration && !await tx.compareAndSet(legacyPath, 'catalog', { expected: this.legacyRaw, value: this.legacyRaw! })) throw conflict();
            await this.writeRecords(tx, records);
            for (const path of new Set([...this.passwords.keys(), ...passwords.keys()])) {
                const before = this.passwords.get(path) ?? null, after = passwords.get(path) ?? null;
                if (before !== after && !await tx.compareAndSet(path, 'password', { expected: before, value: after })) throw conflict();
            }
        });
        this.indexRaw = raw; this.records = records; this.passwords = passwords;
    }
    private async writeRecords(tx: ISeqFileTransaction, next: Map<string, string>): Promise<void> {
        for (const path of new Set([...this.records.keys(), ...next.keys()])) {
            const before = this.records.get(path) ?? null, after = next.get(path) ?? null;
            if (before === after) continue;
            if (!await tx.compareAndSet(path, key, { expected: before, value: after })) throw conflict();
        }
    }
    private async ensureFile(path: string): Promise<void> {
        if (await this.fs.driver.exists(path)) return;
        const split = path.lastIndexOf('/');
        try { await this.fs.driver.createFile({ parentPath: path.slice(0, split), name: path.slice(split + 1), type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
    private transaction<T>(run: (tx: ISeqFileTransaction) => Promise<T>): Promise<T> {
        if (!this.fs.meta.seq?.transaction) throw new FSError('ECAPABILITY', 'Remote grants require transactional records');
        return this.fs.meta.seq.transaction(run);
    }
}
function recordPath(kind: 'remote' | 'projects', id: string): string {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw invalid();
    return `/etc/fs/${kind}/${id}.seq`;
}
function parse(raw: string): unknown { try { return JSON.parse(raw); } catch { throw invalid(); } }
function tolerant(raw: string | null): unknown { try { return raw === null ? null : JSON.parse(raw); } catch { return null; } }
function invalid() { return new FSError('EINVAL', 'Invalid remote file system catalog'); }
function conflict() { return new FSError('ECONFLICT', 'Remote grants changed; reload the project'); }
