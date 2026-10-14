import type { DagPlugin, DagPluginManifest, JsonValue } from '../../contracts';
import { object } from '../structured/value';
import { validateWaitPolicy } from './join-program';

export function controlPlugins(): DagPlugin[] {
    return [value('taskGroup', 'Task group', { maxConcurrency: { type: 'integer', minimum: 1 } }, { maxConcurrency: 4 }),
        value('loop', 'Bounded loop', { maxRounds: { type: 'integer', minimum: 1, maximum: 1000 } }, { maxRounds: 10 }),
        joinPlugin(), value('aggregate', 'Aggregate results', {
            reducer: { type: 'string' }, projection: { type: 'object' }, previous: {}, updates: {},
        }, { reducer: 'latest@1' }, '3.0.0')];
}

function descriptor(id: string, title: string, properties: Record<string, JsonValue>, defaults: Record<string, JsonValue>, version = '1.0.0'): DagPluginManifest {
    return { id: `builtin.${id}`, version, kind: id, title, category: id === 'aggregate' ? 'Data' : 'Control',
        authoring: { scopeRole: id as 'loop' | 'taskGroup' | 'join' | 'aggregate' },
        configSchema: { type: 'object', properties }, defaultConfig: defaults,
        inputs: [{ name: 'input', cardinality: id === 'join' ? 'many' : 'one', required: false, order: 0 }],
        outputs: [{ name: 'result', required: true, order: 0 }] };
}

function presentation(manifest: DagPluginManifest): Pick<DagPlugin, 'manifest' | 'ui'> {
    return { manifest, ui: async () => ({ palette: { label: manifest.title, group: manifest.category },
        node: { summarize: config => JSON.stringify(config) }, inspector: {} }) };
}

function value(id: 'taskGroup' | 'loop' | 'aggregate', title: string, properties: Record<string, JsonValue>, defaults: Record<string, JsonValue>, version?: string): DagPlugin {
    const manifest = descriptor(id, title, properties, defaults, version);
    return { ...presentation(manifest), runtime: async () => ({ createTask(context) {
        return { programKind: 'flow.value', programVersion: '1', input: { operation: id,
            nodeId: context.nodeRunId, config: context.config, inputs: context.inputs, dependencies: context.dependencies } };
    } }) };
}

function joinPlugin(): DagPlugin {
    const manifest = descriptor('join', 'Join tasks', {
        mode: { type: 'string', enum: ['all', 'any', 'first-success', 'quorum'] }, quorum: { type: 'integer', minimum: 1 },
        remaining: { type: 'string', enum: ['continue', 'cancel'] }, failure: { type: 'string', enum: ['fail', 'partial'] },
        result: { type: 'string', enum: ['collect', 'discard'] },
        keys: { type: 'object' },
    }, { mode: 'all', remaining: 'continue', failure: 'fail', result: 'collect' });
    return { ...presentation(manifest), runtime: async () => ({ createTask(context) {
        const policy = { mode: 'all', ...object(context.config) } as import('../../contracts').FlowWaitPolicy;
        const dependencies = context.dependencies.filter(item => item.injectOutput !== false);
        validateWaitPolicy(policy, dependencies.length);
        const keys = object(object(context.config).keys);
        return { programKind: 'flow.join', programVersion: '1', input: { policy, dependencies: dependencies.map(item => ({
            ...item, input: keys[item.nodeId!] ?? item.nodeId,
        })) } };
    } }) };
}
