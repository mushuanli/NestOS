import {API_PROTOCOLS, type ApiProtocol, type LLMModel, type ResponseFormat} from '@itookit/driver-llm/contracts';

export type ModelOutputFormat = ResponseFormat['type'];
type OutputModel = Pick<LLMModel, 'id' | 'category' | 'supportsStructuredOutput'>;

/** Intersect affirmative model declarations with the selected adapter's implemented formats. */
export function modelOutputFormats(model: OutputModel | undefined, protocol: ApiProtocol | undefined): ModelOutputFormat[] {
    if (!model || (model.category ?? 'chat') !== 'chat' || !protocol || !API_PROTOCOLS.includes(protocol)) return [];
    if (model.supportsStructuredOutput !== true) return ['text'];
    return protocol === 'anthropic-messages' ? ['text', 'json_schema'] : ['text', 'json_object', 'json_schema'];
}

/** Admission never changes the requested format or guesses support from a model name. */
export function assertModelOutputFormats(model: OutputModel, protocol: ApiProtocol | undefined, required: readonly ModelOutputFormat[]): void {
    const available = modelOutputFormats(model, protocol);
    for (const format of required) {
        if (available.includes(format)) continue;
        const reason = protocol === 'anthropic-messages' && format === 'json_object'
            ? 'the selected protocol does not implement JSON object mode'
            : model.supportsStructuredOutput !== true && format !== 'text'
                ? 'structured output support is unsupported or unknown for this model' : 'the requested format is unsupported or unknown';
        throw Object.assign(new Error(`Model ${model.id}, protocol ${protocol ?? 'unknown'}, response format ${format}: ${reason}`),
            {code: 'MODEL_OUTPUT_FORMAT_UNSUPPORTED', protocol, format});
    }
}
