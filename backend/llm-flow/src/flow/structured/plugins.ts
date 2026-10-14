import type { DagPlugin, DagPluginManifest, DispatchConfig } from '../../contracts';
import { validateDispatch } from './validation';

export function structuredPlugins(): DagPlugin[] {
    return [plugin(inputManifest(), 'flow.input'), plugin(routeManifest(), 'flow.dispatch')];
}

function plugin(manifest: DagPluginManifest, programKind: string): DagPlugin {
    return { manifest, runtime: async () => ({ createTask(context) {
        if (programKind === 'flow.dispatch') validateDispatch(context.config as DispatchConfig);
        return { programKind, programVersion: '1', input: { ...structuredClone(context.config as object),
            values: context.inputs, dependencies: context.dependencies } };
    } }), ui: async () => ({ palette: { label: manifest.title, group: manifest.category },
        node: { summarize: config => JSON.stringify(config) }, inspector: {} }) };
}

function inputManifest(): DagPluginManifest {
    return { id: 'builtin.input', version: '1.0.0', authoring: { scopeRole: 'input' }, kind: 'input', title: 'Collect Input', category: 'Execution',
        configSchema: { type: 'object', properties: {
            param: { type: 'object' }, fields: { type: 'object' }, prompt: { type: 'string' }, initial: { type: 'object' } } },
        defaultConfig: { param: {}, initial: {} }, inputs: [{ name: 'input', cardinality: 'one', required: false, order: 0 }],
        outputs: [{ name: 'result', required: true, order: 0 }] };
}

function routeManifest(): DagPluginManifest {
    return { id: 'builtin.route', version: '2.0.0', kind: 'route', title: 'Route Tasks', category: 'Control',
        configSchema: { type: 'object', required: ['branches', 'until', 'context', 'maxRounds', 'mode'], properties: {
            invocationDefaults: { type: 'object' }, join: { type: 'object' }, branches: { type: 'array', items: { type: 'object' } }, until: { type: 'object' },
            maxRounds: { type: 'integer', minimum: 1, maximum: 1000 }, maxConcurrency: { type: 'integer', minimum: 1 },
            mode: { type: 'string', enum: ['exclusive', 'multicast'] }, context: { type: 'object' },
            selectionOrder: { type: 'string', enum: ['missing-first', 'declared'] },
            requireNoHistory: { type: 'boolean' }, revision: { type: 'object' },
            publishToHistory: { type: 'boolean' },
            inputRevision: { type: 'string' }, initialResults: { type: 'object' } } },
        defaultConfig: { mode: 'exclusive', maxRounds: 1, maxConcurrency: 1, context: { history: 'none' },
            requireNoHistory: true, until: { kind: 'literal', value: false }, branches: [] },
        inputs: [{ name: 'input', cardinality: 'one', required: false, order: 0 }],
        outputs: [{ name: 'result', required: true, order: 0 }] };
}
