import type { Kernel } from '@itookit/durable-kernel';
import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import { TaskMemoryService, type SessionMemoryProvider } from '@itookit/llm-session';

/** Advertise metadata globally; execution resolves authority from the current persisted Task. */
export function createMemoryTools(kernel: () => Kernel, memory?: () => SessionMemoryProvider): NonNullable<KernelAdaptersRuntimeOptions['effectTools']> {
    return ['memory_list', 'memory_write', 'memory_remove', 'memory_compact'].map(id => {
        const description = id === 'memory_list' ? 'List memories in the current task readable scopes.'
            : id === 'memory_write' ? 'Create or update a memory in a task-authorized scope.'
            : id === 'memory_compact' ? 'Commit a shorter summary of memories read with memory_list. Source revisions must match; originals are retained.'
            : 'Remove a memory from a task-authorized scope.';
        const properties = id === 'memory_list' ? {} : {
            scope: { type: 'string', description: 'Exact authorized scope name.' },
            entryId: { type: 'string', description: 'Stable memory entry identifier.' },
            ...(['memory_write', 'memory_compact'].includes(id) ? { content: { type: 'string' } } : {}),
            ...(id === 'memory_compact' ? { sources: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object',
                properties: { entryId: { type: 'string' }, revision: { type: 'string' } }, required: ['entryId', 'revision'], additionalProperties: false } } } : {}),
            expectedContentHash: { type: ['string', 'null'], description: 'Previous content hash; null requires absence. Omit for unconditional mutation.' },
            expectedRevision: { type: ['string', 'null'], description: 'Revision returned by memory_list; null requires absence. Prefer this condition to detect deletion and recreation.' },
        };
        return {
            meta: { id, name: id, description, sideEffect: id === 'memory_list' ? 'none' : 'local',
                timeoutMs: 30_000, type: 'builtin', enabled: true },
            definition: { type: 'function', function: { name: id, description, parameters: { type: 'object',
                properties, additionalProperties: false, required: id === 'memory_list' ? []
                    : ['scope', 'entryId', ...(['memory_write', 'memory_compact'].includes(id) ? ['content'] : []), ...(id === 'memory_compact' ? ['sources'] : [])] } } },
            invoke: (args, context) => new TaskMemoryService(kernel(), memory?.()).invoke(id, args, context),
        };
    });
}
