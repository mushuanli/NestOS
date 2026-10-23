import { requireMediaCapabilities, resolveModelProtocol, type ConnectionMeta, type LLMProvider } from '@itookit/driver-llm/contracts';
import { hasConnectionCredentials } from './connection';
export interface ModelRequirements { operation: string; inputModalities?: string[]; outputModalities?: string[]; features?: string[] }
export interface ModelConnectionSnapshot { providerId: string; modelId: string; protocol?: string; requirements?: ModelRequirements; mediaEndpoint?: string }
/** Match implemented operations and affirmative model capabilities, without paid probes. */
export function assertModelConnection(connection: ConnectionMeta | undefined, provider: LLMProvider | undefined,
    modelId: string, requirements?: ModelRequirements): void {
    if (!connection || !provider || connection.enabled === false || provider.enabled === false || !hasConnectionCredentials(connection))
        throw new Error('Model connection is unavailable or lacks credentials');
    const model = provider.models.find(item => item.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    if (!requirements) return;
    if (requirements.operation === 'image.generate' || requirements.operation === 'speech.synthesize') {
        if (!connection.hasApiKey && provider.credentialMode !== 'host') throw new Error('Media adapter requires API-key credentials');
        const caps = requireMediaCapabilities(provider, model, requirements.operation);
        for (const [needed, actual] of [[requirements.inputModalities, caps.inputModalities], [requirements.outputModalities, caps.outputModalities],
            [requirements.features, caps.features]] as const)
            if (needed?.some(item => !actual?.includes(item))) throw new Error('Model media capability is unsupported or unknown');
        return;
    }
    if (requirements.operation !== 'chat') throw new Error(`Unsupported runtime operation: ${requirements.operation}`);
    assertChatRequirements(connection, provider, model, requirements);
}
function assertChatRequirements(connection: ConnectionMeta, provider: LLMProvider, model: LLMProvider['models'][number], requirements: ModelRequirements): void {
    if ((model.category ?? 'chat') !== 'chat') throw new Error('Selected model does not support chat');
    if (!resolveModelProtocol(connection, provider, model.id)) throw new Error('Connection protocol capability is unknown');
    const modalities: Record<string, boolean | undefined> = { text: true, image: model.supportsVision, audio: model.supportsAudio, video: model.supportsVideo };
    for (const modality of requirements.inputModalities ?? []) if (modalities[modality] !== true) throw new Error(`Unknown input capability: ${modality}`);
    for (const modality of requirements.outputModalities ?? []) if (modality !== 'text') throw new Error(`Unsupported output capability: ${modality}`);
    const features: Record<string, boolean | undefined> = { tools: model.supportsTools, structuredOutput: model.supportsStructuredOutput, thinking: model.supportsThinking };
    for (const feature of requirements.features ?? []) if (features[feature] !== true) throw new Error(`Unknown model feature: ${feature}`);
}
export function mediaEndpointIdentity(provider: LLMProvider, baseURL: string | undefined, operation: string): string | undefined {
    if (operation !== 'image.generate' && operation !== 'speech.synthesize') return;
    return JSON.stringify({ baseURL: baseURL ?? provider.baseURL, endpoint: provider.media?.[operation] });
}
