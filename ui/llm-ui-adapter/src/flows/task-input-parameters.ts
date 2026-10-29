import type {InteractionRequest, JsonValue} from '@itookit/durable-kernel/contracts';
import type {FlowInputField, FlowParameter} from '@itookit/llm-flow/contracts';

export function taskInputParameters(request: Pick<InteractionRequest<JsonValue>, 'kind' | 'payload'>): FlowParameter[] | undefined {
    const payload = request.payload;
    if (request.kind !== 'input' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const fields = payload.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return;
    const values = payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values) ? payload.values : {};
    return Object.entries(fields).map(([name, field]) => ({...(field as unknown as FlowInputField), name,
        required: (field as unknown as FlowInputField).required !== false,
        ...(Object.hasOwn(values, name) ? {default: values[name]} : {})}));
}
