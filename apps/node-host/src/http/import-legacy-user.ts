import path from 'node:path';
import {mkdir, lstat, rename, rm, cp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {FSError, type IStorageBackend} from '@itookit/vfs-core';
import {type LocalStorageAccess, openLocalFSBackend} from '@itookit/vfsdriver-local';
import {NodeSqliteSidecarDb} from '../storage/sqlite-sidecar';
import {acquireHostLock} from '../storage/host-lock';
import {guardHostStorage} from '../storage/host-storage';
import {UserFiles} from '../storage/user-files';
import {canonical, within} from '../runtime/paths';
import {closeHostResources, type HostCleanup} from '../runtime/host-runtime';
import {AuditLog} from '../logging/audit-log';
import {privateDirectory, userErrorCode} from './user-application';

interface ImportOptions {source: string; sourceAuth?: string; root: string; usersDir: string; auditFile: string}
/** Offline copy preserves SeqFile values through their backend API, rather than copying empty marker files. */
export async function importLegacyUser(options: ImportOptions): Promise<void> {
    const operationId = randomUUID(), started = Date.now(), audit = new AuditLog(options.auditFile), cleanup: HostCleanup = [];
    let stage = 'validation', publishedShared = false, publishedUser = false;
    await audit.initialize(); cleanup.push(() => audit.close());
    const staging = path.join(options.usersDir, `.import-${operationId}`), sharedStage = path.join(options.root, `.etc-${operationId}`);
    try {
        audit.write({event: 'user.import.start', userId: 'admin', operationId, stage, result: 'started'});
        await validateImport(options);
        stage = 'locks';
        cleanup.push(await acquireHostLock(path.join(options.root, '_meta')));
        cleanup.push(await acquireHostLock(path.join(options.source, '_meta')));
        if (options.sourceAuth) cleanup.push(await acquireHostLock(options.sourceAuth));
        await privateDirectory(staging); await privateDirectory(sharedStage);
        stage = 'copy';
        await copyLegacyState(options, staging, sharedStage, cleanup);
        // Close databases before publishing their portable directories.
        stage = 'publish';
        await closeHostResources(cleanup.splice(options.sourceAuth ? 4 : 3));
        await rename(sharedStage, path.join(options.root, 'etc')); publishedShared = true;
        await rename(staging, path.join(options.usersDir, 'admin')); publishedUser = true;
        audit.write({event: 'user.import.complete', userId: 'admin', operationId, stage, result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        audit.write({event: 'user.import.failed', userId: 'admin', operationId, stage, result: 'failure', code: userErrorCode(error, 'USER_IMPORT_FAILED'), durationMs: Date.now() - started});
        throw error;
    } finally {
        if (publishedShared && !publishedUser) await rm(path.join(options.root, 'etc'), {recursive: true, force: true});
        await closeHostResources(cleanup);
        await rm(staging, {recursive: true, force: true}); await rm(sharedStage, {recursive: true, force: true});
    }
}
async function validateImport(options: ImportOptions): Promise<void> {
    const [source, root, users] = await Promise.all([options.source, options.root, options.usersDir].map(value => canonical(path.resolve(value))));
    if (within(source, root) || within(root, source) || within(source, users) || within(users, source) || within(users, root))
        throw new FSError('EINVAL', 'Import requires separate legacy, server and user storage directories');
    for (const target of [path.join(users, 'admin'), path.join(root, 'etc')]) {
        try {await lstat(target); throw new FSError('EEXIST', 'Import refuses to overwrite an existing admin bundle or shared configuration');}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    if (!(await lstat(path.join(source, '_meta', 'index.db'))).isFile()) throw new FSError('EINVAL', 'Legacy import requires the complete _meta/index.db sidecar');
    if (!(await lstat(source)).isDirectory()) throw new FSError('EINVAL', 'Legacy data root must be an existing directory');
    if (options.sourceAuth && !(await lstat(options.sourceAuth)).isDirectory()) throw new FSError('EINVAL', 'Legacy authorization must be an existing directory');
    await privateDirectory(root); await privateDirectory(users);
}
async function openBackend(root: string, meta: string, cleanup: HostCleanup, createFs?: () => UserFiles): Promise<IStorageBackend> {
    await mkdir(root, {recursive: true, mode: 0o700}); await mkdir(meta, {recursive: true, mode: 0o700});
    const backend = await openLocalFSBackend({rootDir: root, sidecarDir: meta, createFs, durability: 'full', createDb: file => NodeSqliteSidecarDb.open(file)});
    cleanup.push(() => backend.close()); return guardHostStorage(backend, root);
}
type Destination = (file: string) => {backend: IStorageBackend; file: string};
async function copyTree(source: IStorageBackend, file: string, destination: Destination): Promise<void> {
    const node = await source.stat(file); if (!node) return;
    const target = destination(file);
    if (node.type === 'directory') {
        await target.backend.mkdir(target.file);
        for (const child of await source.list(file)) await copyTree(source, child.path, destination);
    } else {
        await target.backend.mkdir(path.posix.dirname(target.file));
        await target.backend.write(target.file, await source.read(file));
        await source.records!.walkRecordFields(file, async (field, value) => {await target.backend.records!.setRecordField(target.file, field, value); return true;});
    }
    await copyMetadata(source, file, target.backend, target.file);
    await target.backend.setTags(target.file, [...node.tags]);
}

async function copyMetadata(source: IStorageBackend, from: string, target: IStorageBackend, to: string): Promise<void> {
    const access = (backend: IStorageBackend) => (backend as IStorageBackend & {storageAccess(): LocalStorageAccess}).storageAccess();
    const row = await access(source).transaction(db => db.getMetaExt(from));
    if (row) await access(target).transaction(db => db.upsertMetaExt({...row, path: to}));
}
async function copyLegacyState(options: ImportOptions, staging: string, sharedStage: string, cleanup: HostCleanup): Promise<void> {
    const state = path.join(staging, '.nestos', 'state'), meta = path.join(staging, '.nestos', 'meta');
    await privateDirectory(state); await privateDirectory(meta);
    const source = await openBackend(options.source, path.join(options.source, '_meta'), cleanup);
    const target = await openBackend(state, meta, cleanup, () => new UserFiles(state, staging));
    const shared = new Map<string, IStorageBackend>();
    for (const name of ['llm', 'agents', 'flows']) shared.set(name, await openBackend(path.join(sharedStage, name), path.join(sharedStage, '_meta', name), cleanup));
    const roots = ['/etc/llm', '/home/admin/agents', '/home/admin/flows'];
    await copyTree(source, '/', file => {
        const sharedRoot = roots.find(root => file === root || file.startsWith(root + '/'));
        if (sharedRoot && file !== '/etc/llm/cost.seq') return {backend: shared.get(path.basename(sharedRoot))!, file: file.slice(sharedRoot.length) || '/'};
        return {backend: target, file: file === '/etc/llm/cost.seq' ? '/var/lib/accounting/llm/cost.seq' : file};
    });
    if (options.sourceAuth) await cp(options.sourceAuth, path.join(staging, '.nestos', 'private'), {recursive: true, filter: async sourcePath => {
        if ((await lstat(sourcePath)).isSymbolicLink()) throw new FSError('EACCES', 'Legacy credentials cannot contain symbolic links');
        return !path.basename(sourcePath).startsWith('httpd-host-lock.sqlite');
    }});
}
