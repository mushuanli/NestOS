import type { DagPlugin, DagPluginManifest, JsonValue } from '../../contracts';
import { object } from './value';

export function splitGraphPlugins(agent: DagPluginManifest): DagPlugin[] {
    return [
        manifest('builtin.route', '3.0.0', 'Route checks', { mode: { type: 'string', enum: ['exclusive', 'multicast'] },
            invocationDefaults: invocationSchema(), maxConcurrency: { type: 'integer' }, context: { type: 'object' }, requireNoHistory: { type: 'boolean' },
            selectionOrder: { type: 'string', enum: ['missing-first', 'declared'] } },
            { mode: 'multicast', maxConcurrency: 4, context: { history: 'none' }, requireNoHistory: true }),
        checkManifest(agent),
        revisionManifest(agent),
        manifest('builtin.aggregate', '2.0.0', 'Keep results by type', { strategy: { type: 'string', enum: ['latest', 'append'] },
            reducer: { type: 'string' }, failure: { type: 'string', enum: ['fail', 'partial'] }, projection: { type: 'object' }, initialResults: { type: 'object' } }, { strategy: 'latest' }),
        manifest('builtin.judge', '1.0.0', 'Stop or repeat', { maxRounds: { type: 'integer' }, threshold: { type: 'number' },
            metric: { type: 'string' }, condition: conditionSchema(), until: { type: 'object' }, revision: { type: 'object' } }, { maxRounds: 10, threshold: 9, metric: 'score' }),
    ].map(value => ({ manifest: value, runtime: async () => ({ createTask() {
        throw new Error(`${value.id}@${value.version} requires a connected dispatch scope`);
    } }), ui: async () => ({ palette: { label: value.title, group: 'Review' },
        node: { summarize: config => JSON.stringify(config) }, inspector: {} }) }));
}
function manifest(id: string, version: string, title: string, properties: Record<string, JsonValue>, defaults: Record<string, JsonValue>): DagPluginManifest {
    return { id, version, title, authoring: { scopeRole: id.split('.').pop() as 'route' | 'check' | 'aggregate' | 'judge' | 'revise', invocation: id === 'builtin.route' || id === 'builtin.check' || id === 'builtin.revise' }, kind: id.split('.').pop()!, category: 'Review',
        configSchema: { type: 'object', properties, ...(id === 'builtin.judge' ? { advancedProperties: ['until', 'revision'] } : {}) }, defaultConfig: defaults,
        inputs: [{ name: 'input', cardinality: id === 'builtin.aggregate' ? 'many' : 'one', required: false, order: 0 }],
        outputs: [{ name: 'result', required: true, order: 0 },
            ...(id === 'builtin.judge' ? [{ name: 'repeat', required: false, order: 1 }] : [])] };
}
function checkManifest(agent: DagPluginManifest): DagPluginManifest {
    const properties = object(object(agent.configSchema).properties) as Record<string, JsonValue>;
    const advanced = ['bindings', 'instruction', 'when', 'context', 'publishToHistory', 'output', 'outputFormat', 'outputSchema', 'validate'];
    const result = manifest('builtin.check', '1.0.0', 'Independent check', { ...properties,
        systemPrompt: { type: 'string', format: 'multiline' }, prompt: { type: 'string', format: 'multiline' }, outputContract: { type: 'object' }, instruction: { type: 'string', format: 'multiline' },
        key: { type: 'string' }, bindings: { type: 'object' }, when: { type: 'object' }, context: { type: 'object', properties: { history: { type: 'string', enum: ['none', 'explicit'] }, messages: { type: 'array' } } },
        publishToHistory: { type: 'boolean' }, output: { type: 'object' }, outputFormat: { type: 'string', enum: ['value', 'json'] },
        outputSchema: { type: 'object' }, validate: { type: 'object' } }, { bindings: {}, instruction: '' });
    result.configSchema = { ...object(result.configSchema), advancedProperties: [...new Set([...Object.keys(properties).filter(key =>
        !['systemPrompt', 'agentId', 'connectionId'].includes(key)), ...advanced])] } as JsonValue;
    return result;
}

function invocationSchema(): JsonValue {
    return { type: 'object', properties: {
        connectionId: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string', format: 'multiline' },
        context: { type: 'object', properties: { history: { type: 'string', enum: ['none', 'explicit'] }, messages: { type: 'array' } } },
        outputContract: { type: 'object', properties: { format: { type: 'string', enum: ['json', 'value'] }, onInvalid: { type: 'string', enum: ['fail', 'repair'] }, retries: { type: 'integer' }, schema: { type: 'object' }, select: { type: 'object' }, validate: { type: 'object' } } },
    } };
}

function conditionSchema(): JsonValue {
    return { type: 'object', advancedProperties: ['all', 'any'], properties: {
        value: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] },
        expected: {}, all: { type: 'array' }, any: { type: 'array' },
    } };
}

function revisionManifest(agent: DagPluginManifest): DagPluginManifest {
    const value = checkManifest(agent);
    return { ...value, id: 'builtin.revise', kind: 'revise', title: 'Revise inputs',
        authoring: { scopeRole: 'revise', invocation: true },
        configSchema: { ...object(value.configSchema), properties: { ...object(object(value.configSchema).properties), fields: { type: 'object' } } },
        defaultConfig: { fields: {}, context: { history: 'none' } } };
}
