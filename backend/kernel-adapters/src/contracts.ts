/** Configuration contracts and pure policies; no adapter runtime initialization. */
export * from './llm-management/contracts/agent';
export * from './llm-management/contracts/connection';
export * from './llm-management/contracts/pricing';
export * from './llm-management/contracts/restore';
export * from './llm-management/contracts/presets';
export * from './llm-management/contracts/device';

export type { ConflictStrategy, ConflictItem, ImportStats, ConfigurationImportPort } from './llm-management/contracts/config-import';

export type { SessionCapabilityRegistry, SessionCapabilityScope } from './ports/capabilities';
