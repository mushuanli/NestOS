import {NodeToolConnections} from './tool-connections';
import {ToolOAuthApplications} from './tool-oauth-applications';
import {canonical, within} from './paths';
import path from 'node:path';
import { createApplicationRuntime, type ApplicationRuntime, type ApplicationRuntimeOptions } from '@itookit/app-core';
import { createCellsDriver } from '@itookit/cells-driver';
import { guardHostStorage } from '../storage/host-storage';
import type { IStorageBackend } from '@itookit/vfs-core';
import type { AuditPort } from '../logging/audit-log';
import { openHostRuntime, closeHostResources } from './host-runtime';
import { createStandardNodeTools, loadNodeToolModules, mergeNodePackageTools } from './tool-modules';
import {NodeToolPackages, type NodeToolPackageOptions} from './tool-packages';
import {BUILTIN_TOOLS} from '@itookit/tools';

export interface NodeApplicationOptions {
    oauthApplicationsDirectory?: string;
    authorizationRedirectUri?: string;
    toolPackages?: NodeToolPackageOptions;
    createFs?: () => import('@itookit/vfsdriver-local').IFsOps;
    root: string; sidecar: string; authDir: string; auditFile: string;
    runtime?: Omit<ApplicationRuntimeOptions, 'backend' | 'providerAuthorization'>;
}
export interface NodeApplicationHost {runtime: ApplicationRuntime; audit: AuditPort; close(): Promise<void>}
/** Node capabilities are shared by local CLI and HTTP; application policy stays in app-core. */
export async function openNodeApplication(options: NodeApplicationOptions): Promise<NodeApplicationHost> {
    const resources = await openHostRuntime(options);
    let connections: NodeToolConnections | undefined;
    try {
        const applicationDirectory = await canonical(path.resolve(options.oauthApplicationsDirectory ?? path.join(options.authDir, 'tool-oauth-applications')));
        if (within(resources.root, applicationDirectory)) throw new Error('OAuth application credentials must remain outside the VFS data root');
        connections = new NodeToolConnections(path.join(options.authDir, 'tool-connections'), {redirectUri: options.authorizationRedirectUri,
            applications: new ToolOAuthApplications(applicationDirectory),
            manageApplications: options.runtime?.configurationReadonly !== true});
        const ownedConnections = connections;
        const runtime = await createNodeRuntime(resources.backend, resources.root, {...options.runtime, providerAuthorization: resources.authorization, toolConnections: connections}, {preferencesFile: path.join(options.authDir, 'tool-preferences', 'preferences.json'), ...options.toolPackages});
        let closing: Promise<void> | undefined;
        return {runtime, audit: resources.audit, close: () => closing ??= closeHostResources([resources.close, () => ownedConnections.close(), () => runtime.dispose()])};
    } catch (error) { await connections?.close(); await resources.close(); throw error; }
}

/** Backend ownership remains with the resource host; this factory never closes borrowed storage. */
export async function createNodeRuntime(source: IStorageBackend, root?: string, options: Omit<ApplicationRuntimeOptions, 'backend'> = {}, toolPackages?: NodeToolPackageOptions) {
    const backend = root ? guardHostStorage(source, root) : source;
    const borrowed = new Proxy(backend, {get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const packages = new NodeToolPackages({...toolPackages, connections: options.toolConnections});
    try {
        await packages.initialize();
        const additionalTools = mergeNodePackageTools(packages.userTools([...createStandardNodeTools(), ...await loadNodeToolModules(undefined, options.toolConnections),
            ...options.kernelPlatform?.additionalTools ?? []]), packages.initialTools(), BUILTIN_TOOLS);
        const runtime = await createApplicationRuntime({remoteSourceProvider: createCellsDriver(), ownerKind: 'cli', runningVersion: process.env.NESTOS_HTTPD_VERSION, ...options, backend: borrowed,
            toolDependencies: options.toolDependencies ?? packages,
            kernelPlatform: { ...options.kernelPlatform, additionalTools, configure: async (kernel, services) => {
                await packages.bind(kernel); await options.kernelPlatform?.configure?.(kernel, services);
            } } });
        const dispose = runtime.dispose.bind(runtime); runtime.dispose = async () => {try {await dispose();} finally {await packages.close();}};
        return runtime;
    } catch (error) {await packages.close(); throw error;}
}
