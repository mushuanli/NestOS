import type {LLMProvider} from '@itookit/driver-llm/contracts';
import type {ModelPricingConfig} from './pricing';
import type {ProviderApiReference} from './provider-reference';

/** Device support is independent of credentials, account access and application defaults. */
export interface LlmDeviceCatalog {
    version: number;
    providers: Record<string, LLMProvider>;
    providerReferences: Record<string, ProviderApiReference>;
    pricing: ModelPricingConfig;
}
