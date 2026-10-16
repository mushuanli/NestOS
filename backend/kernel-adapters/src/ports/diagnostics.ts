import type { LLMLogSink } from '@itookit/driver-llm/contracts';

export interface KernelAdapterDiagnostics {
    /** Trusted host gate, executed for every actual model exchange including recovery. */
    authorizeLlm?(request: import('../effects/llm-chat-effect').LlmChatEffectRequest,
        context: import('@itookit/durable-kernel').EffectExecutionContext): Promise<void>;
    authorizeMedia?: import('../effects/llm-media-effect').AuthorizeMedia;
    logger?: LLMLogSink;
    /** Host presentation for a missing process capability. */
    processUnavailableMessage?: () => string;
}

export const silentAdapterLog: LLMLogSink = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
