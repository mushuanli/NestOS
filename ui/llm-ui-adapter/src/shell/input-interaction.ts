import type { InteractionRequest, JsonValue } from '@itookit/durable-kernel/contracts';
import type { ChatInputInteraction } from '../domain/ports/IChatInputPresenter';
import { agentQuestionFields } from '../components/input/agent-questions';

export function inputInteraction(request: InteractionRequest<JsonValue>, revision: number): ChatInputInteraction {
    const data = payloadRecord(request.payload);
    const fields = request.kind === 'input' ? agentQuestionFields(data.questions) : [];
    return {
        key: `${revision}:${request.id}`, id: request.id, kind: request.kind,
        prompt: request.prompt, details: interactionDetails(data, fields.length > 0),
        options: Array.isArray(data.options) ? data.options.filter((item): item is string => typeof item === 'string') : [],
        ...(fields.length ? { fields } : {}),
    };
}

function payloadRecord(payload: JsonValue | undefined): Record<string, JsonValue> {
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function interactionDetails(data: Record<string, JsonValue>, questionsShown: boolean): string | undefined {
    const details = data.plan ?? data.command ?? data.details ?? data.calls ?? (questionsShown ? undefined : data.questions);
    return typeof details === 'string' ? details : details == null ? undefined : JSON.stringify(details, null, 2);
}
