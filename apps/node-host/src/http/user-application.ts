import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FSError} from '@itookit/vfs-core';
import {openLocalFSBackend} from '@itookit/vfsdriver-local';
import {openNodeApplication} from '../runtime/application';
import {closeHostResources, type HostCleanup} from '../runtime/host-runtime';
import {canonical, within, privateDirectory} from '../runtime/paths';
import {acquireHostLock} from '../storage/host-lock';
import {NodeSqliteSidecarDb} from '../storage/sqlite-sidecar';
import {UserFiles} from '../storage/user-files';
import {guardHostStorage} from '../storage/host-storage';
import {NodeEditorSwapStore} from '../storage/editor-swaps';
import type {AuditPort} from '../logging/audit-log';
import {validUserId} from './certificates';
import {ViewApi} from './view-api';
import type {HttpHostOptions} from './start-host';
type HttpRuntimeMounts = import('@itookit/app-core').ApplicationRuntimeOptions['additionalMounts'];

export function userAudit(audit: AuditPort, userId: string): AuditPort {
    return {write: event => audit.write({...event, userId}), close: async () => {}};
}
export function userErrorCode(error: unknown, fallback = 'USER_RUNTIME_INITIALIZATION_FAILED'): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}
export {privateDirectory} from '../runtime/paths';
async function openBackend(root: string, meta: string, cleanup: HostCleanup) {
    await privateDirectory(root); await privateDirectory(meta);
    const backend = await openLocalFSBackend({rootDir: root, sidecarDir: meta, durability: 'full', createDb: file => NodeSqliteSidecarDb.open(file)});
    cleanup.push(() => backend.close());
    return guardHostStorage(backend, root);
}

/** One bundle owns all mutable user state; only explicitly mounted definitions are shared. */
export async function openUserApplication(options: HttpHostOptions, userId: string, audit: AuditPort) {
    if (!validUserId(userId)) throw new FSError('EACCES', 'Invalid enrolled user identity');
    const cleanup: HostCleanup = [], scoped = userAudit(audit, userId), operationId = randomUUID(), started = Date.now();
    let stage = 'paths';
    scoped.write({event: 'user.runtime.start', operationId, stage, result: 'started'});
    try {
        const home = await privateDirectory(path.join(options.usersDir!, userId)), internal = path.join(home, '.nestos');
        await privateDirectory(internal);
        cleanup.push(await acquireHostLock(path.join(internal, 'host-lock')));
        scoped.write({event: 'user.paths.ready', operationId, stage, result: 'success', durationMs: Date.now() - started});
        stage = 'configuration';
        const mounts = await sharedMounts(options, userId, cleanup);
        scoped.write({event: 'user.configuration.ready', operationId, stage, result: 'success', count: mounts.length, durationMs: Date.now() - started});
        stage = 'storage';
        const host = await openUserRuntime(options, home, internal, mounts, userId !== 'admin', cleanup);
        scoped.write({event: 'user.storage.ready', operationId, stage, result: 'success', durationMs: Date.now() - started});
        const application = new ViewApi(Promise.resolve(host.runtime), scoped, false, userId !== 'admin');
        cleanup.push(() => application.close());
        scoped.write({event: 'user.runtime.ready', operationId, stage: 'ready', result: 'success', durationMs: Date.now() - started});
        return {application, close: () => closeUser(cleanup, scoped)};
    } catch (error) {
        scoped.write({event: 'user.runtime.failed', operationId, stage, result: 'failure', code: userErrorCode(error), durationMs: Date.now() - started});
        try {await closeHostResources(cleanup);} catch {scoped.write({event: 'user.runtime.cleanup.failed', operationId, result: 'failure', code: 'USER_CLEANUP_FAILED'});}
        throw error;
    }
}

export async function validateUserHostPaths(options: HttpHostOptions): Promise<void> {
    const [users, root, web] = await Promise.all([options.usersDir!, options.root, options.staticDir].map(value => canonical(path.resolve(value))));
    const audit = await canonical(path.resolve(options.auditFile));
    const internals = ['etc', '_meta', 'tools', 'bin'].map(name => path.join(root, name));
    if (within(web, users) || within(users, web) || within(web, root) || within(web, audit)
        || within(users, root) || users === root || within(users, audit) || internals.some(internal => within(internal, users) || within(users, internal)))
        throw new FSError('EINVAL', 'User bundles, shared configuration, static UI and audit paths must not overlap');
    await privateDirectory(users);
}

async function sharedMounts(options: HttpHostOptions, userId: string, cleanup: HostCleanup): Promise<NonNullable<HttpRuntimeMounts>> {
    const mounts: NonNullable<HttpRuntimeMounts> = [];
    for (const name of ['llm', 'agents', 'flows']) {
        const backend = await openBackend(path.join(options.root, 'etc', name), path.join(options.root, 'etc', '_meta', name), cleanup);
        mounts.push({path: name === 'llm' ? '/etc/llm' : `/home/admin/${name}`, backend,
            options: {readonly: userId !== 'admin', crossMountStrategy: 'deny'}});
    }
    return mounts;
}
async function openUserRuntime(options: HttpHostOptions, home: string, internal: string, mounts: NonNullable<HttpRuntimeMounts>, configurationReadonly: boolean, cleanup: HostCleanup) {
    const state = path.join(internal, 'state');
    await privateDirectory(state); await privateDirectory(path.join(internal, 'meta')); await privateDirectory(path.join(internal, 'private'));
    const host = await openNodeApplication({root: state, sidecar: path.join(internal, 'meta'), authDir: path.join(internal, 'private'), createFs: () => new UserFiles(state, home),
        toolPackages: {directories: configurationReadonly ? [] : undefined, dataDirectory: path.join(options.root, 'tools'), registryFile: path.join(options.root, 'etc', 'tool-packages.json')},
        auditFile: path.join(internal, 'logs', 'audit.jsonl'), runtime: {startupMode: 'server', additionalMounts: mounts,
            sharedLlmConfiguration: true, configurationReadonly, costStorageRoot: '/var/lib/accounting'}});
    cleanup.push(host.close);
    if (options.editorSwap?.enabled) {
        const swap = await NodeEditorSwapStore.start(path.join(internal, 'swap'), state, options.staticDir);
        host.runtime.editorSwapStore = swap; cleanup.push(() => swap.dispose());
    }
    return host;
}
async function closeUser(cleanup: HostCleanup, audit: AuditPort): Promise<void> {
    const started = Date.now(), operationId = randomUUID();
    try {await closeHostResources(cleanup); audit.write({event: 'user.runtime.closed', operationId, result: 'success', durationMs: Date.now() - started});}
    catch (error) {audit.write({event: 'user.runtime.closed', operationId, result: 'failure', code: userErrorCode(error), durationMs: Date.now() - started}); throw error;}
}
