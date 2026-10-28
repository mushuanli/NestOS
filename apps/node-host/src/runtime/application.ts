import { createApplicationRuntime, type ApplicationRuntime, type ApplicationRuntimeOptions } from '@itookit/app-core';
import { createNestOSNodeDriver } from '@itookit/nestos-node-driver';
import { guardHostStorage } from '../storage/host-storage';
import type { IStorageBackend } from '@itookit/vfs-core';
import type { AuditPort } from '../logging/audit-log';
import { openHostRuntime, closeHostResources } from './host-runtime';
import { createStandardNodeTools, loadNodeToolModules, mergeNodePackageTools } from './tool-modules';
import {NodeToolPackages, type NodeToolPackageOptions} from './tool-packages';
import {BUILTIN_TOOLS} from '@itookit/tools';

export interface NodeApplicationOptions {
    toolPackages?: NodeToolPackageOptions;
    createFs?: () => import('@itookit/vfsdriver-local').IFsOps;
    root: string; sidecar: string; authDir: string; auditFile: string;
    runtime?: Omit<ApplicationRuntimeOptions, 'backend' | 'providerAuthorization'>;
}
export interface NodeApplicationHost {runtime: ApplicationRuntime; audit: AuditPort; close(): Promise<void>}
/** Node capabilities are shared by local CLI and HTTP; application policy stays in app-core. */
export async function openNodeApplication(options: NodeApplicationOptions): Promise<NodeApplicationHost> {
    const resources = await openHostRuntime(options);
    try {
        const runtime = await createNodeRuntime(resources.backend, resources.root, {...options.runtime, providerAuthorization: resources.authorization}, options.toolPackages);
        let closing: Promise<void> | undefined;
        return {runtime, audit: resources.audit, close: () => closing ??= closeHostResources([resources.close, () => runtime.dispose()])};
    } catch (error) { await resources.close(); throw error; }
}

/** Backend ownership remains with the resource host; this factory never closes borrowed storage. */
export async function createNodeRuntime(source: IStorageBackend, root?: string, options: Omit<ApplicationRuntimeOptions, 'backend'> = {}, toolPackages?: NodeToolPackageOptions) {
    const backend = root ? guardHostStorage(source, root) : source;
    const borrowed = new Proxy(backend, {get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const packages = new NodeToolPackages(toolPackages);
    try {
        await packages.initialize();
        const additionalTools = mergeNodePackageTools([...createStandardNodeTools(), ...await loadNodeToolModules(),
            ...options.kernelPlatform?.additionalTools ?? []], packages.initialTools(), BUILTIN_TOOLS);
        const runtime = await createApplicationRuntime({remoteSourceProvider: createNestOSNodeDriver(), ownerKind: 'cli', ...options, backend: borrowed,
            toolDependencies: options.toolDependencies ?? packages,
            kernelPlatform: { ...options.kernelPlatform, additionalTools, configure: async (kernel, services) => {
                packages.bind(kernel); await options.kernelPlatform?.configure?.(kernel, services);
            } } });
        const dispose = runtime.dispose.bind(runtime); runtime.dispose = async () => {try {await dispose();} finally {await packages.close();}};
        return runtime;
    } catch (error) {await packages.close(); throw error;}
}
