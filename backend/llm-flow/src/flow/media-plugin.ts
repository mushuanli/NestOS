import type { DagPlugin, JsonValue } from '../contracts';
/** Media operations use generic Connection capabilities. */
export function mediaPlugin(): DagPlugin {
    const manifest = { id: 'builtin.media', version: '1.0.0', kind: 'media', title: 'Media', category: 'Execution',
        configSchema: { type: 'object', required: ['operation', 'request'], properties: {
            operation: { type: 'string', enum: ['image.generate', 'speech.synthesize'] }, connectionId: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 }, connectionSlot: { type: 'string' }, modelName: { type: 'string' }, request: { type: 'object', required: ['format'], properties: {
                format: { type: 'string' }, prompt: { type: 'string' }, input: { type: 'string' }, voice: { type: 'string' },
                size: { type: 'string' }, quality: { type: 'string' }, count: { type: 'integer', minimum: 1 }, speed: { type: 'number' }, instructions: { type: 'string' } } },
        } } as Record<string, JsonValue>, defaultConfig: { operation: 'image.generate', request: { prompt: '', format: 'png' } },
        inputs: [{ name: 'input', cardinality: 'many' as const, required: false, order: 0 }], outputs: [{ name: 'result', required: true, order: 0 }],
    };
    return { manifest, runtime: async () => ({ createTask(context) {
        const config = context.config as Record<string, JsonValue>;
        return { programKind: 'kernel-adapters.media', programVersion: '1', input: { connectionId: config.connectionId,
            connectionSnapshot: config.frozenConnection, timeoutMs: config.timeoutMs, request: { ...config.request as Record<string, JsonValue>, operation: config.operation, model: config.modelName } } };
    } }), ui: async () => ({ palette: { label: manifest.title, group: manifest.category }, node: { summarize: config => String((config as Record<string, unknown>).operation ?? '') }, inspector: {} }) };
}
