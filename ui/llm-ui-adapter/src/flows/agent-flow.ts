import { createModuleLogger, t, randomUUID } from '@itookit/common';
import { FlowCommand, type FlowRevision, type JsonValue } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { ExecutorOption } from '../domain/types';
import { promptFlowParameters } from '../components/FlowParameterForm';
import { flowConnectionSelection } from './connection-selection';
import {agentFlowInput} from './agent-flow-input';

const log = createModuleLogger('agent-flow');

export interface AgentFlowSubmission {
    connectionId?: string;
    flowParameters: Record<string, JsonValue>;
    flowConnectionBindings?: Record<string, string>;
}

export interface AgentFlowDraftInput {
    text: string;
    files: readonly File[];
}

interface AgentFlowTrace {operationId: string; started: number; stage: string; draft?: AgentFlowDraftInput;}

/** The backend resolves the Agent binding again; this read only builds the run form. */
export async function prepareAgentFlow(commands: ICommandBus, agent: ExecutorOption, signal: AbortSignal,
    draft?: AgentFlowDraftInput): Promise<AgentFlowSubmission | null> {
    const execution = agent.execution;
    if (execution?.kind !== 'flow') return null;
    const trace = {stage: 'definition', started: Date.now(), operationId: randomUUID(), draft};
    recordPreparation(trace, 'start');
    try {
        const flow = await commands.execute<FlowRevision | null>(FlowCommand.RevisionGet, { id: execution.flowId, revision: execution.revision });
        if (signal.aborted) {recordPreparation(trace, 'cancelled'); return null;}
        if (!flow) throw Object.assign(new Error(t('agent.execution.unavailable')), { code: 'FLOW_UNAVAILABLE' });
        const {parameters, initialFiles} = agentFlowInput(flow.parameters ?? [], draft, execution.parameters);
        trace.stage = 'connections';
        const connection = await flowConnectionSelection(commands, undefined, flow.connections, execution.connectionBindings, flow, agent);
        if (signal.aborted) {recordPreparation(trace, 'cancelled'); return null;}
        trace.stage = 'parameters';
        const composite = !!agent.composition && !parameters.length && !flow.connections?.length;
        if (composite) await connection.validate?.();
        const values = composite ? {} : await promptFlowParameters(parameters, `${agent.name} · ${t('agent.execution.runParameters')}`,
            undefined, signal, connection, undefined, t('flow.launch.reviewInputs'), {initialFiles, inputGroups: flow.inputGroups, submitLabel: 'flow.launch.start'});
        const result = values === null || signal.aborted ? null : { flowParameters: values, flowConnectionBindings: connection.bindings, connectionId: connection.selected };
        recordPreparation(trace, result === null ? 'cancelled' : 'ready');
        return result;
    } catch (error) {
        if (signal.aborted) {recordPreparation(trace, 'cancelled'); return null;}
        recordPreparation(trace, 'failure', failureCategory(error));
        throw error;
    }
}

function recordPreparation({operationId, started, stage, draft}: AgentFlowTrace, result: string, category?: string): void {
    const data = {operation: 'agent.flow.prepare', operationId, stage, result, category, durationMs: Date.now() - started,
        fileCount: draft?.files.length ?? 0, textLength: draft?.text.length ?? 0};
    if (result === 'failure') log.warn('agent.flow.prepare', data); else log.info('agent.flow.prepare', data);
}

function failureCategory(error: unknown): string {
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'FLOW_PREPARATION_FAILED';
}

export function agentUnavailableReason(agent: ExecutorOption | undefined): string | undefined {
    return agent?.availability?.status === 'disabled'
        ? t(`agent.execution.reason.${agent.availability.reason ?? 'flow-invalid'}`) : undefined;
}
