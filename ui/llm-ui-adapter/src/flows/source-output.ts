import type {DurableFlowSnapshot, JsonValue} from '@itookit/llm-flow/contracts';
export interface SourceValue {label: string; value: JsonValue}
/** Expose values rather than output-envelope metadata, without coercing objects to text. */
export function sourceValues(snapshot: DurableFlowSnapshot): SourceValue[] {
    const task = snapshot.root.task;
    if (task.status !== 'succeeded') throw new Error(task.exit?.error?.message ?? task.lastError?.message ?? `Source run is ${task.status}`);
    const output = task.output as {nodes?: Record<string, {outputs?: Record<string, {content?: JsonValue}>}>} | undefined;
    const nodes = output?.nodes ?? {}, selected = nodes.__flow_return ? {result: nodes.__flow_return} : nodes;
    const result: SourceValue[] = [];
    for (const [node, value] of Object.entries(selected)) for (const [port, data] of Object.entries(value.outputs ?? {}))
        if (Object.hasOwn(data, 'content')) collect(`${node}/${port}`, data.content!, result, 0);
    if (!result.length && task.output !== undefined) collect('result', task.output as JsonValue, result, 0);
    return result;
}
function collect(label: string, value: JsonValue, values: SourceValue[], depth: number): void {
    if (values.length >= 200) return;
    values.push({label, value});
    if (depth >= 6 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) collect(`${label}/${key}`, child, values, depth + 1);
}
