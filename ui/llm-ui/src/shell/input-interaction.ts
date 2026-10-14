import type { InteractionRequest, JsonValue } from '@itookit/durable-kernel/contracts';
import type { ChatInputInteraction } from '../domain/ports/IChatInputPresenter';

export function inputInteraction(request: InteractionRequest<JsonValue>, revision: number): ChatInputInteraction {
    const payload = request.payload;
    const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const details = data.plan ?? data.command ?? data.details ?? data.calls ?? data.questions;
    const content = typeof details === 'string' ? details : details == null ? undefined : JSON.stringify(details, null, 2);
    return {
        key: `${revision}:${request.id}`, id: request.id, kind: request.kind,
        prompt: request.prompt, details: content,
        options: Array.isArray(data.options) ? data.options.filter((item): item is string => typeof item === 'string') : [],
    };
}
