import type { LLMConfigFile } from '../constants/llm-loader';
export type ConflictStrategy = 'skip' | 'overwrite' | 'rename';

export interface ConflictItem {
    type: 'provider' | 'connection' | 'agent' | 'skill';
    id: string;
    name: string;
}

export interface ImportStats {
    providers: number;
    connections: number;
    agents: number;
    skills: number;
    skipped: number;
}


export interface ConfigurationImportPort {
    previewConfigurationImport(config: LLMConfigFile): Promise<ConflictItem[]>;
    importConfiguration(config: LLMConfigFile, strategy: ConflictStrategy): Promise<ImportStats>;
}
