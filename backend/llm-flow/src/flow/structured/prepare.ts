import type { DagNodeDefinition, DagPluginCatalog, DispatchBranch, DispatchConfig, FlowInvocationDefaults, JsonValue } from '../../contracts';
import type { TaskSpec } from '@itookit/durable-kernel';
import { validateSchema } from '../validation';
import type { DispatchInput, PreparedBranch } from './types';
import { json, object } from './value';
import { validateDispatch } from './validation';

export interface DispatchPreparation {
    plugins: DagPluginCatalog;
    bind(node: DagNodeDefinition): Promise<DagNodeDefinition>;
    task(node: DagNodeDefinition): Promise<TaskSpec>;
}

export async function prepareDispatch(input: Omit<DispatchInput, 'branches' | 'revision'> & Pick<DispatchConfig, 'branches' | 'revision'>, context: DispatchPreparation): Promise<DispatchInput> {
    validateDispatch(input);
    const branches: PreparedBranch[] = [];
    for (const branch of input.branches) branches.push(await configuredBranch(branch, input.invocationDefaults, context));
    const invocation = input.revision?.invocation;
    const revision = input.revision ? { ...input.revision, ...(invocation ? { invocation: await configuredBranch(invocation,
        { connectionId: input.invocationDefaults?.connectionId, model: input.invocationDefaults?.model }, context) } : {}) } : undefined;
    return json({ ...input, branches, revision }) as DispatchInput;
}

async function configuredBranch(branch: DispatchBranch, defaults: FlowInvocationDefaults | undefined, context: DispatchPreparation): Promise<PreparedBranch> {
    const contract = branch.outputContract ?? defaults?.outputContract;
    const target = { ...branch.target, config: { ...(defaults?.connectionId ? { connectionId: defaults.connectionId } : {}),
        ...(defaults?.model ? { model: defaults.model } : {}), ...object(branch.target.config),
        ...(contract?.onInvalid ? { outputValidation: { onInvalid: contract.onInvalid, retries: contract.retries ?? (contract.onInvalid === 'repair' ? 3 : 0) } } : {}),
    } };
    return prepareBranch({ ...branch, target: target as DispatchBranch['target'],
        context: branch.context ?? defaults?.context,
        outputFormat: branch.outputFormat ?? contract?.format, outputSchema: branch.outputSchema ?? contract?.schema,
        output: branch.output ?? contract?.select, validate: branch.validate ?? contract?.validate,
    }, context);
}

async function prepareBranch(branch: DispatchBranch, context: DispatchPreparation): Promise<PreparedBranch> {
    const target = await bindInvocation(branch, context);
    const raw = object(branch.target.config);
    const config = object(target.config);
    if ((raw.agentId || raw.systemPromptId) && !Array.isArray(config.invocationInstructions)) {
        throw new Error('Invocation references require a host identity binder');
    }
    const instructions = Array.isArray(config.invocationInstructions) ? config.invocationInstructions
        : [...(Array.isArray(raw.systemPrompt) ? raw.systemPrompt : []), ...(typeof raw.instruction === 'string' ? [raw.instruction] : [])];
    const isolated = { ...config };
    for (const key of ['memoryPolicy', 'messages', 'sessionContext', 'delegation', 'subtasks']) delete isolated[key];
    isolated.messages = [];
    target.config = isolated;
    const task = await context.task(target);
    task.deferStart = true;
    if (task.program.kind === 'llm.agent' || task.program.kind === 'llm.chat') task.input = sanitizeInput(task.input);
    return { ...branch, target: json(target) as DispatchBranch['target'], task: json(task),
        instructions: instructions.filter((v: unknown): v is string => typeof v === 'string') };
}

async function bindInvocation(branch: DispatchBranch, context: DispatchPreparation): Promise<DagNodeDefinition> {
    let target = structuredClone(branch.target) as DagNodeDefinition;
    if (target.plugin === 'builtin.flow' || (target.plugin === 'builtin.route' && target.pluginVersion === '2.0.0')) {
        throw new Error('Nested dispatch/composite targets require an explicit separate DAG scope');
    }
    const raw = object(target.config);
    const manifest = context.plugins.getManifest(target.plugin, target.pluginVersion);
    if (!manifest) throw new Error(`Unknown invocation plugin: ${target.plugin}`);
    const errors = validateSchema(manifest.configSchema, target.config as JsonValue);
    if (errors.length) throw new Error(`Invalid invocation ${branch.key}: ${errors.join('; ')}`);
    target.config = { ...raw, invocationContext: 'isolated', historyPolicy: 'none',
        ...(branch.outputFormat === 'json' && branch.outputSchema && !raw.responseFormat ? {
            responseFormat: { type: 'json_schema', json_schema: { name: 'flow_result', schema: branch.outputSchema, strict: true } },
        } : {}),
    };
    return context.bind(target);
}

function sanitizeInput(input: unknown): JsonValue {
    const value = { ...object(input) };
    for (const key of ['messages', 'memoryPolicy', 'sessionContext']) delete value[key];
    value.dependencyBindings = [];
    value.includeDependencyOutputs = false;
    return json(value) as JsonValue;
}
