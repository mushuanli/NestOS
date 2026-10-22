import { requireMediaCapabilities, type ConnectionMeta, type LLMModel, type LLMProvider } from '@itookit/driver-llm/contracts';
import { resolveChatModelForTier, resolveModelForTier } from './connection';

export const MODEL_OPERATIONS = ['chat', 'image.generate', 'speech.synthesize'] as const;
export type ModelOperation = typeof MODEL_OPERATIONS[number];
export type ModelDefaults = Partial<Record<ModelOperation, string>>;

export function isModelOperation(value: unknown): value is ModelOperation {
    return typeof value === 'string' && MODEL_OPERATIONS.some(operation => operation === value);
}

/** Resolve models selected by connection metadata, without skipping invalid tier bindings. */
export function modelForOperation(connection: ConnectionMeta, provider: LLMProvider | undefined,
    operation: ModelOperation): LLMModel | undefined {
    if (operation === 'chat') return resolveChatModelForTier(connection, provider, 'optimal');
    if (!provider) return;
    const ids = (['optimal', 'standard', 'fast'] as const).map(tier => resolveModelForTier(connection, tier));
    for (const id of new Set(ids)) {
        const model = provider.models.find(item => item.id === id);
        if (!model) continue;
        try { requireMediaCapabilities(provider, model, operation); return model; } catch { /* Try the next configured model. */ }
    }
}

export function operationModelNames(connection: ConnectionMeta, provider: LLMProvider | undefined): Partial<Record<ModelOperation, string>> {
    return Object.fromEntries(MODEL_OPERATIONS.flatMap(operation => {
        const model = modelForOperation(connection, provider, operation);
        return model ? [[operation, model.name || model.id]] : [];
    }));
}
