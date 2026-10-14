import type { ToolDefinition } from '../domain/message';
import type { ContentRef, IContextService, WorkingNotes } from '../domain/durable';
import { ContextError } from '../window/engine';

export const CONTEXT_TOOL_IDS = ['context_history', 'context_read', 'context_checkpoint'] as const;

export function contextToolDefinitions(): ToolDefinition[] {
    return [
        tool('context_history', 'List recent task history or search it. Results are bounded. Pass the returned cursor unchanged to continue.', {
            query: { type: 'string' }, cursor: { type: 'object' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        }),
        tool('context_read', 'Read a bounded portion of stored output. Use the content reference printed in its preview.', {
            ref: { type: 'object' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32768 },
        }, ['ref']),
        tool('context_checkpoint', 'Propose working notes for a new context window. Include progress, unresolved issues and next actions. This never completes the task or authorizes tools.', {
            text: { type: 'string' }, revision: { type: 'integer', minimum: 1 },
        }, ['text', 'revision']),
    ];
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export async function invokeContextTool(service: IContextService, contextId: string, name: string, args: Record<string, unknown>) {
    const current = await service.inspect(contextId);
    if (name === 'context_history') return { output: JSON.stringify({ revision: current?.revision, ...await service.history(contextId, args) }) };
    if (name === 'context_read') return { output: JSON.stringify(await service.read(args.ref as ContentRef, args.offset as number, args.limit as number)) };
    if (name !== 'context_checkpoint') throw new ContextError('CONTEXT_UNKNOWN_TOOL', 'Unknown context tool');
    if (!current || args.revision !== current.revision || typeof args.text !== 'string' || !args.text.trim()
        || new TextEncoder().encode(args.text).length > 8192) throw new ContextError('CONTEXT_CHECKPOINT_REQUIRED', 'Checkpoint requires current revision and bounded non-empty notes');
    const checkpoint: WorkingNotes = { revision: (current.notes?.revision ?? 0) + 1,
        basedOnRevision: current.revision, text: args.text, evidence: [current.history] };
    return { output: 'Checkpoint proposed. It will be applied at the next complete tool boundary.', checkpoint };
}
