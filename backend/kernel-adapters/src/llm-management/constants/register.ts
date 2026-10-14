// @file: device-llm/constants/register.ts
// Runtime registration of external .llm configs into the global provider/connection catalogs.
// Legacy-only mutation; new hosts compose catalogs explicitly before driver construction.

import type { LLMConfigFile } from './llm-loader';
import { toLLMProvider } from './llm-loader';
import { LLM_PROVIDERS } from './providers';
import { DEFAULT_CONNECTIONS } from './connections';

/**
 * Register an external .llm config into the global provider and connection catalogs.
 *
 * Mutates LLM_PROVIDERS and DEFAULT_CONNECTIONS in-place.
 * Must be called before constructing the legacy LLMDeviceDriver.
 * @deprecated Use composeLlmPresets from the /llm/config entry and inject the result into /llm/core.
 */
export function registerLLMConfig(config: LLMConfigFile): void {
    const defs = config.providers ?? (config.provider ? [config.provider] : []);

    for (const def of defs) {
        // Skip if already registered (idempotent — same as connection guard below)
        if (LLM_PROVIDERS[def.id]) {
            console.warn(`[registerLLMConfig] Provider "${def.id}" already registered, skipping external definition`);
            continue;
        }
        LLM_PROVIDERS[def.id] = toLLMProvider(def);
    }

    for (const conn of config.connections ?? []) {
        // Skip if already registered (idempotent)
        if (DEFAULT_CONNECTIONS.some(c => c.id === conn.id)) continue;
        DEFAULT_CONNECTIONS.push({
            id: conn.id,
            name: conn.name,
            providerId: conn.providerId,
            tiers: conn.tiers,
        });
    }
}
