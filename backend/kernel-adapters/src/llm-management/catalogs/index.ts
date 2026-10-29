// @file: kernel-adapters/llm-management/catalogs/index.ts
import { LLM_PROVIDERS, MODEL_PRICING } from './providers';
import { DOUBAO_SPEECH_REFERENCE } from './doubao-speech';
import { MODEL_PRICE_CATALOG } from './model-prices';
import type { LlmDeviceCatalog } from '../contracts/device-catalog';

/**
 * NestOS product provider catalog.
 *
 * This module is reachable only from the optional `/llm/presets` entry; the mechanism
 * entries (`/llm/core`, `/llm/config`, `/contracts`) must never load it. Each call returns
 * its own snapshot so a host cannot mutate a shared registry.
 */
export function createLlmDeviceCatalog(): LlmDeviceCatalog {
    return structuredClone({version: 1, providers: LLM_PROVIDERS,
        providerReferences: {'doubao-speech': DOUBAO_SPEECH_REFERENCE},
        pricing: {model_pricing: MODEL_PRICING, reference_catalog: MODEL_PRICE_CATALOG}});
}
