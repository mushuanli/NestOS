import type { FlowConnection, FlowRevision, JsonValue } from '@itookit/llm-flow/contracts';
import type { ModelRequirements } from '@itookit/kernel-adapters/contracts';

/** Pure Flow requirements shared by admission and form projection. */
export function inferFlowConnectionRequirements(flow: Pick<FlowRevision, 'nodes' | 'connections'>): FlowConnection[] {
    const slots = structuredClone(flow.connections ?? []);
    for (const node of flow.nodes.filter(item => item.plugin === 'builtin.media' || item.plugin === 'builtin.agent')) {
        const config = record(node.config);
        const slot = nodeSlot(node, slots);
        if (!slot) continue;
        slot.requirements = nodeRequirements(node.plugin === 'builtin.agent' ? 'chat' : String(config.operation), config, slot);
    }
    return slots;
}
export function nodeSlot(node: FlowRevision['nodes'][number], slots: FlowConnection[]): FlowConnection | undefined {
    const config = record(node.config);
    const name = config.connectionSlot ?? config.connectionId;
    return slots.find(item => item.name === name);
}
export function nodeRequirements(operation: string, config: Record<string, JsonValue>, slot?: FlowConnection) {
    const declared = config.connectionRequirements as unknown as ModelRequirements | undefined;
    if (declared && declared.operation !== operation) throw new Error('Node requirements conflict with operation');
    if (slot?.requirements && slot.requirements.operation !== operation) throw new Error('Node operation conflicts with connection slot');
    const output = operation === 'chat' ? 'text' : operation === 'image.generate' ? 'image' : 'audio';
    return { operation, inputModalities: [...new Set(['text', ...messageModalities(config.messageTemplates ?? config.messages), ...declared?.inputModalities ?? [], ...slot?.requirements?.inputModalities ?? []])],
        outputModalities: [...new Set([output, ...declared?.outputModalities ?? [], ...slot?.requirements?.outputModalities ?? []])],
        features: [...new Set([...declared?.features ?? [], ...slot?.requirements?.features ?? []])] };
}
function messageModalities(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(message => contentModalities(message?.content));
}
function contentModalities(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(part => {
        if (!part || typeof part !== 'object') return [];
        const modality = { image_url: 'image', image: 'image', input_audio: 'audio', audio: 'audio', video: 'video' }[String(part.type)];
        return modality ? [modality] : part.type === 'tool_result' ? contentModalities(part.content) : [];
    });
}
function record(value: unknown): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
