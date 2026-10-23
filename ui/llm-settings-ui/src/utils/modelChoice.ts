import type {LLMModel} from '@itookit/driver-llm/contracts';
import type {ModelPricingConfig} from '@itookit/kernel-adapters/contracts';
import {t} from '@itookit/common';
import {modelCapabilityIndicators} from './modelBadges';
import {modelPriceLabel} from './modelPrice';
export {modelPriceLabel} from './modelPrice';

export function modelCapabilityLabels(model: LLMModel): string[] {
    const labels = [t(`model.category.${model.category ?? 'chat'}`)];
    const fields = [['supportsVision', 'vision'], ['supportsThinking', 'thinking'], ['supportsTools', 'tools'],
        ['supportsAudio', 'audio'], ['supportsVideo', 'video'], ['supportsStructuredOutput', 'structuredOutput']] as const;
    for (const [field, key] of fields) if (model[field] === true) labels.push(t(`model.capability.${key}`));
    if (model.operations?.['image.generate'] || model.supportedOperations?.includes('image.generate')) labels.push(t('model.capability.imageGeneration'));
    if (model.operations?.['speech.synthesize'] || model.supportedOperations?.includes('speech.synthesize')) labels.push(t('model.capability.speechSynthesis'));
    if (labels.length === 1 && model.capabilitiesKnown !== true) labels.push(t('connection.modelCapabilitiesUnknown'));
    return labels;
}

export function modelChoiceLabel(model: LLMModel, providerId: string, pricing?: ModelPricingConfig): string {
    const name = model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
    const indicators = modelCapabilityIndicators(model).map(item => `${item.icon} ${item.label}`).join(' / ');
    return `${name} · ${indicators || modelCapabilityLabels(model).join(' / ')} · ${modelPriceLabel(model, providerId, pricing)}`;
}

/** Every search term must match the model identity or an explicitly declared capability. */
export function matchesModelQuery(model: LLMModel, query: string): boolean {
    const flags = Object.keys(model).filter(key => key.startsWith('supports') && model[key as keyof LLMModel] === true);
    const corpus = [model.id, model.name, model.category, ...flags, ...Object.keys(model.operations ?? {}),
        ...(model.supportedOperations ?? []), ...modelCapabilityLabels(model)].join(' ').toLowerCase();
    return query.toLowerCase().split(/[\s,，]+/u).filter(Boolean).every(term => corpus.includes(term));
}
