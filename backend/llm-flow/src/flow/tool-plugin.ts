import type { DagPlugin, JsonValue } from '../contracts';
export function toolPlugin(): DagPlugin {
    const manifest = { id: 'builtin.tool', version: '1.0.0', kind: 'tool', title: 'Tool', category: 'Execution',
        configSchema: { type: 'object', required: ['toolId', 'toolVersion', 'args'], properties: { toolId: { type: 'string', minLength: 1 },
            toolVersion: { type: 'string', minLength: 1 }, args: { type: 'object' }, approval: { type: 'string', enum: ['all', 'none'] },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 } } } as Record<string, JsonValue>,
        defaultConfig: { toolId: '', toolVersion: '', args: {}, approval: 'all' },
        inputs: [{ name: 'input', cardinality: 'many' as const, required: false, order: 0 }], outputs: [{ name: 'result', required: true, order: 0 }],
    };
    return { manifest, runtime: async () => ({ createTask(context) {
        const config = context.config as Record<string, JsonValue>;
        return { programKind: 'kernel-adapters.tool', programVersion: '1', input: { toolId: config.toolId, toolVersion: config.toolVersion,
            args: config.args, approval: config.approval ?? 'all', ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) } };
    } }), ui: async () => ({ palette: { label: manifest.title, group: manifest.category }, node: { summarize: config => String((config as Record<string, unknown>).toolId ?? '') }, inspector: {} }) };
}
