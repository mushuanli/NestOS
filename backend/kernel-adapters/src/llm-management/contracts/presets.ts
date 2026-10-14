import type { LLMProvider, LLMConnection } from '@itookit/driver-llm/contracts';
import type { InitialAgentDef } from './agent';
import type { DefaultConnectionDef } from './connection';
import type { ModelPricingConfig } from './pricing';

export interface LlmManagementPresets {
    version: number;
    providers: Record<string, LLMProvider>;
    connections: DefaultConnectionDef[];
    agents: InitialAgentDef[];
    pricing: ModelPricingConfig;
}
export type ProviderConnectionPolicy = (provider: LLMProvider, connections: readonly LLMConnection[]) => LLMConnection | undefined;

/** Snapshot caller-owned data so different runtimes never share mutable preset catalogs. */
export function snapshotLlmPresets(presets?: Partial<LlmManagementPresets>): LlmManagementPresets {
    return structuredClone({ version: presets?.version ?? 0, providers: presets?.providers ?? {},
        connections: presets?.connections ?? [], agents: presets?.agents ?? [],
        pricing: presets?.pricing ?? { model_pricing: [] } });
}
