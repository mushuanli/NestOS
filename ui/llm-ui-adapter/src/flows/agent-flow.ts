import { t, randomUUID } from '@itookit/common';
import { FlowCommand, type FlowRevision, type JsonValue } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { ExecutorOption } from '../domain/types';
import { promptFlowParameters } from '../components/FlowParameterForm';
import { flowConnectionSelection } from './connection-selection';

export interface AgentFlowSubmission {
    connectionId?: string;
    flowParameters: Record<string, JsonValue>;
    flowConnectionBindings?: Record<string, string>;
}

/** The backend resolves the Agent binding again; this read only builds the run form. */
export async function prepareAgentFlow(commands: ICommandBus, agent: ExecutorOption, signal: AbortSignal): Promise<AgentFlowSubmission | null> {
    const execution = agent.execution;
    if (execution?.kind !== 'flow') return null;
    const started = Date.now(), operationId = randomUUID();
    let stage = 'definition';
    try {
        const flow = await commands.execute<FlowRevision | null>(FlowCommand.RevisionGet, { id: execution.flowId, revision: execution.revision });
        if (signal.aborted) return null;
        if (!flow) throw Object.assign(new Error(t('agent.execution.unavailable')), { code: 'FLOW_UNAVAILABLE' });
        const parameters = (flow.parameters ?? []).map(field => ({ ...field,
            ...(Object.hasOwn(execution.parameters ?? {}, field.name) ? { default: execution.parameters![field.name] as JsonValue } : {}) }));
        stage = 'connections';
        const connection = await flowConnectionSelection(commands, undefined, flow.connections, execution.connectionBindings, flow, agent);
        if (signal.aborted) return null;
        stage = 'parameters';
        const composite = !!agent.composition && !parameters.length && !flow.connections?.length;
        if (composite) await connection.validate?.();
        const values = composite ? {} : await promptFlowParameters(parameters, `${agent.name} · ${t('agent.execution.runParameters')}`, undefined, signal, connection, undefined, t('agent.execution.promptHint'));
        const result = values === null || signal.aborted ? null : { flowParameters: values, flowConnectionBindings: connection.bindings, connectionId: connection.selected };
        console.info('[Agent Flow]', { operation: 'agent.flow.prepare', stage, operationId, result: result === null ? 'cancelled' : 'ready', durationMs: Date.now() - started, parameterCount: parameters.length });
        return result;
    } catch (error) {
        console.warn('[Agent Flow]', { operation: 'agent.flow.prepare', stage, operationId, result: 'failure', durationMs: Date.now() - started, category: failureCategory(error) });
        throw error;
    }
}

function failureCategory(error: unknown): string {
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : 'unknown';
}

export function agentUnavailableReason(agent: ExecutorOption | undefined): string | undefined {
    return agent?.availability?.status === 'disabled'
        ? t(`agent.execution.reason.${agent.availability.reason ?? 'flow-invalid'}`) : undefined;
}
