import type { TaskSpec } from '@itookit/durable-kernel';
import type { SkillContext } from '@itookit/llm-tasks';
import type { ToolDefinition } from '@itookit/llm-context';
import type { DagNodeDefinition, DagPluginCatalog, DagTaskDefinition, DagTaskDependencyBinding, JsonValue } from '../contracts';
import type { DispatchInput } from './structured/types';
import { prepareDispatch } from './structured/prepare';
import { subtaskToolDef, subtaskToolDescription, subtaskToolName } from './delegation-runtime';

/** Host capability resolution used for one run; no task submission or scheduler state. */
export interface FlowTaskFactoryOptions {
    sessionId: string;
    plugins: DagPluginCatalog;
    contextProgramVersion: '1' | '2';
    resolveTools?(sessionId: string, allowedIds: string[]): Promise<{ definitions: ToolDefinition[]; externalIds: string[] }>;
    resolveSkillContexts?(sessionId: string, skillIds: string[], allowedToolIds: string[]): Promise<SkillContext[]>;
    bindPatchNode?(sessionId: string, node: DagNodeDefinition, defaults?: Record<string, unknown>): Promise<Partial<Pick<DagNodeDefinition, 'config' | 'inputs'>>>;
}

/** Convert a plugin task into a Kernel request using the run's fixed program version. */
export class FlowTaskFactory {
    constructor(private readonly options: FlowTaskFactoryOptions) {}

    async create(node: DagNodeDefinition, task: DagTaskDefinition, dependencies: DagTaskDependencyBinding[],
        parameters?: Record<string, JsonValue>, requestId?: string): Promise<TaskSpec<unknown>> {
        const input = await this.prepareInput(node, task, parameters, requestId);
        return {
            ...(requestId ? { requestId } : {}),
            program: { kind: task.programKind, version: task.programVersion === '1' && ['llm.agent', 'llm.chat'].includes(task.programKind)
                ? this.options.contextProgramVersion : task.programVersion },
            input: JSON.parse(JSON.stringify(input ?? null)) as JsonValue,
            dependsOn: dependencies.filter(binding => task.programKind !== 'flow.join' || binding.injectOutput === false).map(binding => ({
                task: binding.taskId, ...(binding.onFailure ? { onFailure: binding.onFailure } : {}),
            })),
            retry: node.retry,
            priority: node.priority ?? task.priority,
            labels: nodeLabels(node),
            deferStart: task.programKind === 'llm.agent' || task.programKind === 'llm.chat',
        };
    }

    private async prepareInput(node: DagNodeDefinition, task: DagTaskDefinition,
        parameters?: Record<string, JsonValue>, requestId?: string): Promise<unknown> {
        const allowed = node.capabilities ?? [];
        // Preserve host resolution for every plugin, including nested dispatch targets.
        const catalog = await this.options.resolveTools?.(this.options.sessionId, allowed)
            ?? { definitions: [], externalIds: [] };
        switch (task.programKind) {
            case 'flow.dispatch': return this.prepareDispatch({ ...task.input as DispatchInput, invocationNamespace: requestId! });
            case 'flow.input': return { ...record(task.input), values: { ...parameters, ...record(record(task.input).values) } };
            case 'llm.agent': return this.agentInput(node, task, allowed, catalog);
            case 'flow.value': return { ...record(task.input), parameters, iteration: Number(/#(\d+)(?:@|$)/.exec(requestId ?? '')?.[1] ?? 1) };
            default: return task.input;
        }
    }

    private async agentInput(node: DagNodeDefinition, task: DagTaskDefinition, allowed: string[],
        catalog: { definitions: ToolDefinition[]; externalIds: string[] }): Promise<unknown> {
        const subtaskTool = subtaskToolName(node.config);
        const skillIds = stringIds(record(node.config).skillIds);
        const skillContexts = skillIds.length && this.options.resolveSkillContexts
            ? await this.options.resolveSkillContexts(this.options.sessionId, skillIds, allowed) : [];
        return {
            ...record(task.input),
            tools: [...catalog.definitions, ...(subtaskTool ? [subtaskToolDef(subtaskTool, subtaskToolDescription(node.config))] : [])],
            externalToolIds: catalog.externalIds,
            allowedToolIds: allowed,
            ...(skillContexts.length ? { skillContexts } : {}),
        };
    }

    private async prepareDispatch(input: DispatchInput): Promise<DispatchInput> {
        const { sessionId, plugins } = this.options;
        return prepareDispatch(input, {
            plugins,
            bind: async target => {
                const patch = await this.options.bindPatchNode?.(sessionId, target, undefined);
                return { ...target, ...patch };
            },
            task: async target => {
                const runtime = await plugins.loadRuntime(target.plugin, target.pluginVersion);
                const task = runtime.createTask({ sessionId, nodeRunId: target.id, config: target.config,
                    inputs: target.inputs, dependencies: [] });
                return this.create(target, task, []);
            },
        });
    }
}

function nodeLabels(node: DagNodeDefinition): Record<string, string> {
    const agentId = record(node.config).agentId;
    return { flowNodeId: node.id, flowNodeName: node.name, plugin: node.plugin,
        ...(typeof agentId === 'string' ? { agentId } : {}),
        ...(node.outputPolicy?.publishToHistory === false ? { flowHistory: 'omit' } : {}) };
}

/** Ignore invalid Skill ids instead of coercing them into capabilities. */
function stringIds(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))] : [];
}

function record(value: unknown): Record<string, JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
