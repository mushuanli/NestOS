import {requireMediaCapabilities, supportsMediaEndpoint, type ConnectionMeta, type LLMModel, type LLMProvider} from '@itookit/driver-llm/contracts';
import { resolveModelForTier } from '@itookit/kernel-adapters/contracts';

/** Catalog declarations describe discoverability; credentials remain a separate readiness check. */
export function modelCapabilities(provider: LLMProvider | undefined, models = provider?.models ?? []): string[] {
    return [...new Set(models.flatMap(model => {
        if (model.capabilitiesKnown === false) return [];
        const tags = (model.category ?? 'chat') === 'chat' ? ['chat'] : [];
        if (model.supportsVision) tags.push('vision');
        if (model.supportsTools) tags.push('tools');
        if (model.supportsThinking) tags.push('thinking');
        if (model.supportsVideo || model.category === 'video') tags.push('video');
        if (model.supportsStructuredOutput) tags.push('structuredOutput');
        if (model.supportsAudio || model.category === 'audio') tags.push('audio');
        if (model.category === 'embedding') tags.push('embedding');
        for (const operation of ['image.generate', 'speech.synthesize'] as const) {
            if (model.supportedOperations?.includes(operation) && supportsMediaEndpoint(provider?.media?.[operation], operation)) {
                tags.push(operation); continue;
            }
            try { if (provider) { requireMediaCapabilities(provider, model, operation); tags.push(operation); } }
            catch { /* An unknown or unsupported adapter never becomes an affirmative capability. */ }
        }
        return tags;
    }))];
}

export function configuredModels(connection: ConnectionMeta, provider?: LLMProvider): LLMModel[] {
    const tiers = ['optimal', 'standard', 'fast'] as const;
    const ids = new Set(tiers.map(tier => resolveModelForTier(connection, tier)));
    return (provider?.models ?? []).filter(model => ids.has(model.id));
}

export function runnableModel(provider: LLMProvider | undefined, models: LLMModel[]): LLMModel | undefined {
    return models.find(model => {
        if ((model.category ?? 'chat') === 'chat' && model.capabilitiesKnown !== false) return true;
        return (['image.generate', 'speech.synthesize'] as const).some(operation => {
            try {if (provider) {requireMediaCapabilities(provider, model, operation); return true;}} catch { /* Admission requires complete constraints. */ }
            return false;
        });
    });
}
