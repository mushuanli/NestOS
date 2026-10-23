import {LLM_PROVIDERS, MODEL_PRICING} from './providers';
import {DOUBAO_SPEECH_REFERENCE} from './catalogs/doubao-speech';
import {MODEL_PRICE_CATALOG} from './catalogs/model-prices';
import type {LlmDeviceCatalog} from './contracts';
export type {LlmDeviceCatalog} from './contracts';

/** Each host receives its own device support snapshot, without a mutable global registry. */
export function createLlmDeviceCatalog(): LlmDeviceCatalog {
    return structuredClone({version: 1, providers: LLM_PROVIDERS,
        providerReferences: {'doubao-speech': DOUBAO_SPEECH_REFERENCE},
        pricing: {model_pricing: MODEL_PRICING, reference_catalog: MODEL_PRICE_CATALOG}});
}

/** A known provider identifies device support; it does not imply credentials or account access. */
export function supportsLlmProvider(providerId: string): boolean {
    return Object.hasOwn(LLM_PROVIDERS, providerId);
}
