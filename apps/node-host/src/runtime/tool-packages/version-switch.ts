import type {Tool} from '@itookit/tools';
import type {ToolConnectionAccess, ToolConnectionType} from '@itookit/app-contracts/services';
import {validateToolConnectionDefinition} from '../tool-connections';
import {packageError, type ToolPackageSource} from './manifest';
import {stageToolPackage, type InstalledToolPackage} from './install';
import {readToolPackageRegistry, withToolPackageRegistry, writeToolPackageRegistry, syncToolPackageRegistry, type RegisteredToolPackage} from './store';
import {ImplementationRecords} from './execution-records';
import {disposePackageTools} from './disposal';
import {prepareUpgradeGroup, rollbackActivations, type PreparedActivation} from './upgrade-group';

/** Publish one durable pointer and all loaded user runtimes at one synchronous barrier. */
export async function stageVersionSwitch(source: ToolPackageSource, active: InstalledToolPackage, directory: string,
    registryFile: string, env: NodeJS.ProcessEnv, catalog: {getToolMeta(id: string): {version?: string} | undefined},
    implementations: ImplementationRecords, operationId: string): Promise<RegisteredToolPackage> {
    return withToolPackageRegistry(registryFile, async () => {
        const records = await readToolPackageRegistry(registryFile), current = records.find(row => row.id === active.registration.id);
        if (current?.version === source.manifest.version && current.activationId === operationId) return current;
        if (current?.version !== active.registration.version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'Registered version changed; refresh before switching versions');
        // Factory validation has no access to live user connections while preparing an inactive version.
        // Validate inactive factories without replacing the running host's executable leases.
        const staged = await stageToolPackage(source, directory, env, stagingConnections(), active.registration.bindings);
        await disposePackageTools(staged.tools, 'factory-validation');
        assertCompatibleTools(active.tools, staged.tools, catalog);
        assertIsolatedExecutables(active, staged);
        const registration = {...staged.registration, previousVersion: active.registration.version, activationId: operationId};
        await implementations.save(active.registration); await implementations.save(registration);
        const prepared = await prepareUpgradeGroup(registryFile, registration);
        await commitVersion(registryFile, records, registration, prepared);
        return registration;
    });
}

async function commitVersion(file: string, previous: RegisteredToolPackage[], registration: RegisteredToolPackage, prepared: PreparedActivation[]): Promise<void> {
    try {
        for (const plan of prepared) plan.check();
        try {await writeToolPackageRegistry(file, previous.map(row => row.id === registration.id ? registration : row));}
        catch (error) {
            const observed = await readToolPackageRegistry(file).catch(() => undefined);
            if (!observed) {for (const plan of prepared) plan.block(); throw packageError('TOOL_PACKAGE_UPGRADE_INDETERMINATE', 'Version pointer outcome is unknown; refresh to reconcile before another upgrade');}
            if (observed.find(row => row.id === registration.id)?.activationId !== registration.activationId) throw error;
            await syncToolPackageRegistry(file);
        }
        for (const plan of prepared) plan.commit();
    } catch (error) {
        for (const plan of prepared) plan.block();
        const restored = await rollbackActivations(prepared);
        const observed = await readToolPackageRegistry(file).catch(() => undefined);
        if (observed?.find(row => row.id === registration.id)?.activationId === registration.activationId) {
            try {await writeToolPackageRegistry(file, previous);}
            catch {for (const plan of prepared) plan.block(); throw packageError('TOOL_PACKAGE_UPGRADE_INDETERMINATE', 'Activation rollback needs registry reconciliation');}
        }
        const prior = previous.find(row => row.id === registration.id), actual = observed?.find(row => row.id === registration.id);
        const known = actual?.activationId === registration.activationId || actual?.version === prior?.version && actual?.fingerprint === prior?.fingerprint;
        if (!restored || !known) throw packageError('TOOL_PACKAGE_UPGRADE_INDETERMINATE', 'Activation rollback needs runtime and registry reconciliation');
        for (const plan of prepared) plan.resume();
        throw error;
    }
}
function assertIsolatedExecutables(previous: InstalledToolPackage, next: InstalledToolPackage): void {
    const same = JSON.stringify(previous.registration.bindings) === JSON.stringify(next.registration.bindings);
    if (!same && (previous.registration.bindings.length > 0 && previous.source.manifest.executionEnvironment !== 'instance'
        || next.registration.bindings.length > 0 && next.source.manifest.executionEnvironment !== 'instance'))
        throw packageError('TOOL_PACKAGE_EXECUTABLE_ISOLATION_REQUIRED', 'Hot upgrades with changed binaries require instance-bound executables in both versions');
}

function stagingConnections(): ToolConnectionAccess {
    const types = new Map<string, ToolConnectionType>();
    const denied = async (): Promise<never> => {throw packageError('TOOL_PACKAGE_STAGE_CONNECTION_ACCESS_DENIED', 'Inactive factories cannot access user account data');};
    return {register: type => {
        try {validateToolConnectionDefinition(type);} catch {throw packageError('TOOL_PACKAGE_CONNECTION_INVALID', 'The selected version declares an invalid connection definition');}
        types.set(type.id, structuredClone(type));
    }, snapshot: async () => ({types: [...types.values()], connections: []}), resolve: denied, save: denied, remove: denied};
}

export function assertCompatibleTools(previous: Tool[], next: Tool[], catalog: {getToolMeta(id: string): {version?: string} | undefined}): void {
    for (const tool of previous) {
        const replacement = next.find(candidate => candidate.name === tool.name);
        if (!replacement || (replacement.version ?? '1') !== (tool.version ?? '1'))
            throw packageError('TOOL_PACKAGE_SWITCH_INCOMPATIBLE', 'The selected package removes or changes an existing tool identity');
    }
    if (next.some(tool => !previous.some(candidate => candidate.name === tool.name) && catalog.getToolMeta(tool.name)))
        throw packageError('TOOL_PACKAGE_TOOL_CONFLICT', 'An added tool identity is already owned by another installed tool');
}
