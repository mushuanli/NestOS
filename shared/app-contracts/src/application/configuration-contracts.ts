import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';

/** Configuration operations are explicit capabilities, not arbitrary service RPC. */
export const CONFIGURATION_READS = [
    'getAgents', 'getAgentConfig', 'getConnections', 'getConnection', 'getDefaultConnection',
    'getFullConnection', 'getProviders', 'getFullProvider', 'getProviderDefaults',
    'listSystemPrompts', 'getSystemPrompt', 'getSkills', 'getMCPServers',
    'queryCosts', 'getPricingConfig', 'getPricingDefaults', 'getRestorableItems',
] as const;
export const CONFIGURATION_WRITES = [
    'saveAgent', 'deleteAgent', 'saveConnection', 'deleteConnection', 'setDefaultConnection',
    'saveProvider', 'deleteProvider', 'saveSystemPrompt', 'deleteSystemPrompt',
    'saveSkill', 'deleteSkill', 'saveMCPServer', 'deleteMCPServer', 'writePricing',
    'restoreItem', 'resetAllDefaults', 'testConnection', 'listProviderModels', 'testMCPServer',
] as const;
export type ConfigurationRead = typeof CONFIGURATION_READS[number];
export type ConfigurationWrite = typeof CONFIGURATION_WRITES[number];
export type ConfigurationOperation = ConfigurationRead | ConfigurationWrite;
export type ConfigurationArgs<K extends ConfigurationOperation> = Parameters<IAgentManagementService[K]>;
export type ConfigurationResult<K extends ConfigurationOperation> = Awaited<ReturnType<IAgentManagementService[K]>>;
export type ConfigurationRequest<K extends ConfigurationOperation> = {
    [P in K]: { operation: P; args: ConfigurationArgs<P> }
}[K];
export interface ApplicationConfigurationPort {
    read<K extends ConfigurationRead>(operation: K, ...args: ConfigurationArgs<K>): Promise<ConfigurationResult<K>>;
    execute<K extends ConfigurationWrite>(operation: K, ...args: ConfigurationArgs<K>): Promise<ConfigurationResult<K>>;
    subscribe(listener: () => void): () => void;
}

/** Tuple arity is enforced at the wire boundary before readiness or side effects. */
export const CONFIGURATION_ARITY: Record<ConfigurationOperation, readonly [number, number]> = {
    getAgents: [0, 0], getAgentConfig: [1, 1], getConnections: [0, 0], getConnection: [1, 1],
    getDefaultConnection: [0, 0], getFullConnection: [1, 1], getProviders: [0, 0],
    getFullProvider: [1, 1], getProviderDefaults: [0, 0], listSystemPrompts: [0, 0],
    getSystemPrompt: [1, 1], getSkills: [0, 0], getMCPServers: [0, 0], queryCosts: [0, 1],
    getPricingConfig: [0, 0], getPricingDefaults: [0, 0], getRestorableItems: [0, 0],
    saveAgent: [1, 2], deleteAgent: [1, 1], saveConnection: [1, 1], deleteConnection: [1, 1],
    setDefaultConnection: [1, 1], saveProvider: [1, 1], deleteProvider: [1, 1],
    saveSystemPrompt: [1, 1], deleteSystemPrompt: [1, 1], saveSkill: [1, 1], deleteSkill: [1, 1],
    saveMCPServer: [1, 1], deleteMCPServer: [1, 1], writePricing: [1, 1], restoreItem: [2, 2],
    resetAllDefaults: [0, 0], testConnection: [1, 1], listProviderModels: [1, 1], testMCPServer: [1, 1],
};
