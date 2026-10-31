import type {Tool} from '@itookit/tools';
import type {ToolConnectionAccess, ToolConnectionType} from '@itookit/app-contracts/services';
import {validateToolConnectionDefinition} from '../tool-connections';
import {packageError, type ToolPackageSource} from './manifest';
import {stageToolPackage, type InstalledToolPackage} from './install';
import {readToolPackageRegistry, withToolPackageRegistry, writeToolPackageRegistry, type RegisteredToolPackage} from './store';

/** Prepare the next startup without replacing tool instances in existing user runtimes. */
export async function stageVersionSwitch(source: ToolPackageSource, active: InstalledToolPackage, directory: string,
    registryFile: string, env: NodeJS.ProcessEnv, catalog: {getToolMeta(id: string): {version?: string} | undefined}): Promise<RegisteredToolPackage> {
    return withToolPackageRegistry(registryFile, async () => {
        const records = await readToolPackageRegistry(registryFile), current = records.find(row => row.id === active.registration.id);
        if (current?.version === source.manifest.version && current.previousVersion === active.registration.version) return current;
        if (current?.version !== active.registration.version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'Registered version changed; refresh before switching versions');
        // Factory validation has no access to live user connections while preparing an inactive version.
        // Validate inactive factories without replacing the running host's executable leases.
        const staged = await stageToolPackage(source, directory, env, stagingConnections(), active.registration.bindings);
        assertCompatibleTools(active.tools, staged.tools, catalog);
        const registration = {...staged.registration, previousVersion: active.registration.version};
        await writeToolPackageRegistry(registryFile, records.map(row => row.id === registration.id ? registration : row));
        return registration;
    });
}

function stagingConnections(): ToolConnectionAccess {
    const types = new Map<string, ToolConnectionType>();
    const denied = async (): Promise<never> => {throw packageError('TOOL_PACKAGE_STAGE_CONNECTION_ACCESS_DENIED', 'Inactive factories cannot access user account data');};
    return {register: type => {
        try {validateToolConnectionDefinition(type);} catch {throw packageError('TOOL_PACKAGE_CONNECTION_INVALID', 'The selected version declares an invalid connection definition');}
        types.set(type.id, structuredClone(type));
    }, snapshot: async () => ({types: [...types.values()], connections: []}), resolve: denied, save: denied, remove: denied};
}

function assertCompatibleTools(previous: Tool[], next: Tool[], catalog: {getToolMeta(id: string): {version?: string} | undefined}): void {
    for (const tool of previous) {
        const replacement = next.find(candidate => candidate.name === tool.name);
        if (!replacement || (replacement.version ?? '1') !== (tool.version ?? '1'))
            throw packageError('TOOL_PACKAGE_SWITCH_INCOMPATIBLE', 'The selected package removes or changes an existing tool identity');
    }
    if (next.some(tool => !previous.some(candidate => candidate.name === tool.name) && catalog.getToolMeta(tool.name)))
        throw packageError('TOOL_PACKAGE_TOOL_CONFLICT', 'An added tool identity is already owned by another installed tool');
}
