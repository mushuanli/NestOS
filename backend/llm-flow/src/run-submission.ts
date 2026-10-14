import type { DagRunSpec, JsonValue } from './contracts';
import { bindCapabilities, type CapabilityBinding, type Kernel, type TaskHandle, type TaskSpec } from '@itookit/durable-kernel';
import type { DurableFlowExecutor, FlowExecutionHandle } from './flow/executor';

/** Trusted, compiled input. Session history and source configuration stay with the caller. */
export type CompiledRunDefinition = TaskRunDefinition | GraphRunDefinition;

export interface TaskRunDefinition {
    kind: 'task';
    sessionId: string;
    task: Omit<TaskSpec, 'deferStart'>;
    capabilities: CapabilityBinding[];
}

export interface GraphRunDefinition {
    kind: 'graph';
    sessionId: string;
    graph: DagRunSpec;
    parameters?: Record<string, JsonValue>;
}

export interface RunExecution {
    root: TaskHandle;
    /** Read live membership: graph expansion can add tasks after submission. */
    tasks(): TaskHandle[];
}

export interface GraphRunExecution extends RunExecution {
    flow: FlowExecutionHandle;
}

interface RunSubmissionOptions {
    kernel: Pick<Kernel, 'openSession'>;
    flowExecutor?: Pick<DurableFlowExecutor, 'submit'>;
}

export function submitRun(definition: GraphRunDefinition, options: RunSubmissionOptions): Promise<GraphRunExecution>;
export function submitRun(definition: CompiledRunDefinition, options: RunSubmissionOptions): Promise<RunExecution>;
export async function submitRun(definition: CompiledRunDefinition, options: RunSubmissionOptions): Promise<RunExecution | GraphRunExecution> {
    if (definition.kind === 'graph') {
        if (!options.flowExecutor) throw new Error('Graph run requires a flow executor');
        const flow = await options.flowExecutor.submit(definition.sessionId, definition.graph, definition.parameters);
        return { root: flow.root, tasks: () => [...new Map([...flow.nodes.values(), ...(flow.childTasks?.values() ?? [])]
            .map(task => [task.id, task])).values()], flow };
    }
    const session = await options.kernel.openSession(definition.sessionId);
    const root = await session.submit({ ...definition.task, deferStart: true });
    await bindCapabilities(root, definition.capabilities);
    return { root, tasks: () => [root] };
}
