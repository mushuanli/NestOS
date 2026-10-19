import { createApplicationRuntime, type ApplicationRuntime, type ApplicationRuntimeOptions } from '@itookit/app-core';
import { createMindOSNodeClient } from '@itookit/mindos-node-client';
import { guardHostStorage } from '../storage/host-storage';
import type { IStorageBackend } from '@itookit/vfs-core';
import type { AuditPort } from '../logging/audit-log';
import { openHostRuntime, closeHostResources } from './host-runtime';

export interface NodeApplicationOptions {
    root: string; sidecar: string; authDir: string; auditFile: string;
    runtime?: Omit<ApplicationRuntimeOptions, 'backend' | 'providerAuthorization'>;
}
export interface NodeApplicationHost {runtime: ApplicationRuntime; audit: AuditPort; close(): Promise<void>}
/** Node capabilities are shared by local CLI and HTTP; application policy stays in app-core. */
export async function openNodeApplication(options: NodeApplicationOptions): Promise<NodeApplicationHost> {
    const resources = await openHostRuntime(options);
    try {
        const runtime = await createNodeRuntime(resources.backend, resources.root, {...options.runtime, providerAuthorization: resources.authorization});
        let closing: Promise<void> | undefined;
        return {runtime, audit: resources.audit, close: () => closing ??= closeHostResources([resources.close, () => runtime.dispose()])};
    } catch (error) { await resources.close(); throw error; }
}

/** Backend ownership remains with the resource host; this factory never closes borrowed storage. */
export function createNodeRuntime(source: IStorageBackend, root?: string, options: Omit<ApplicationRuntimeOptions, 'backend'> = {}) {
    const backend = root ? guardHostStorage(source, root) : source;
    const borrowed = new Proxy(backend, {get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    return createApplicationRuntime({remoteSourceProvider: createMindOSNodeClient(), ownerKind: 'cli', ...options, backend: borrowed});
}
