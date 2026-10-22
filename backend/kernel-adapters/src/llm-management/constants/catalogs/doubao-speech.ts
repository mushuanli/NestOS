import source from './doubao-speech.json';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import type { ProviderApiReference } from '../../contracts/provider-reference';

export const DOUBAO_SPEECH_REFERENCE = source.reference as ProviderApiReference;

/** Only implemented resource models enter the runnable catalog; body-model variants stay documentation. */
export function createDoubaoSpeechProvider(): LLMProvider {
    const reference = DOUBAO_SPEECH_REFERENCE;
    const speed = reference.parameters.find(parameter => parameter.clientField === 'speed');
    if (speed?.min === undefined || speed.max === undefined) throw new TypeError('Speech catalog requires speed constraints');
    return { ...source.provider as Omit<LLMProvider, 'models'>, models: reference.models
        .filter(model => model.kind === 'resource' && model.support === 'implemented').map(model => ({
            id: model.id, name: model.name, category: 'audio', capabilitiesKnown: true,
            operations: {'speech.synthesize': {inputModalities: ['text'], outputModalities: ['audio'],
                formats: reference.formats.filter(format => format.support === 'implemented').map(format => format.id),
                voices: reference.voices.map(voice => voice.id), speedRange: {min: 1 + speed.min! / 100, max: 1 + speed.max! / 100}},},
        })) };
}
