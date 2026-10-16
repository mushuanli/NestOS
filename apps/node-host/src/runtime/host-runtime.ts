import path from 'node:path';
import {resolveHostPaths} from './paths';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '../storage/sqlite-sidecar';
import { AuditLog } from '../logging/audit-log';
import { PrivateAuthStore } from '../authorization/private-store';
import { ChatGPTAuthorization } from '../authorization/chatgpt-authorization';
import { acquireHostLock } from '../storage/host-lock';

export type HostCleanup = Array<() => void | Promise<void>>;
export async function closeHostResources(callbacks: HostCleanup): Promise<void> {
    const errors: unknown[] = [];
    for (const close of callbacks.splice(0).reverse()) {
        try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Node host cleanup failed');
}
export async function openHostRuntime(options: { root: string; sidecar: string; authDir: string; auditFile: string }) {
    options = await resolveHostPaths(options);
    const cleanup: HostCleanup = [];
    try {
        cleanup.push(await acquireHostLock(path.join(options.root, '_meta')));
        cleanup.push(await acquireHostLock(options.authDir));
        const store = new PrivateAuthStore(options.authDir); await store.initialize();
        const backend = await openLocalFSBackend({ rootDir: options.root, sidecarDir: options.sidecar,
            durability: 'full', createDb: file => NodeSqliteSidecarDb.open(file) });
        cleanup.push(() => backend.close());
        const audit = new AuditLog(options.auditFile); await audit.initialize(); cleanup.push(() => audit.close());
        const authorization = new ChatGPTAuthorization(store, undefined, audit); cleanup.push(() => authorization.close());
        return { root: options.root, backend, audit, authorization, close: () => closeHostResources(cleanup) };
    } catch (error) {
        try { await closeHostResources(cleanup); } catch { /* Preserve the startup error. */ }
        throw error;
    }
}
