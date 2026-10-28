import {ParameterSources} from './parameter-sources';
import {resolveFlowArguments} from './flow-arguments';
import type {ResourceScope} from '@itookit/app-contracts';
import { createModuleLogger, t, randomUUID } from '@itookit/common';
import {assertRootCallable, FlowCommand, type FlowRevision, type JsonValue} from '@itookit/llm-flow/contracts';
import type {RootCallTarget} from '@itookit/llm-session/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { ExecutorOption } from '../domain/types';
import { promptFlowParameters } from '../components/FlowParameterForm';
import { flowConnectionSelection } from './connection-selection';
import {confirmedFlowInput} from './agent-flow-input';
import {validateComposerFiles} from './composer-file-bindings';

const log = createModuleLogger('agent-flow');

export interface AgentFlowSubmission {
    connectionId?: string;
    flowParameters: Record<string, JsonValue>;
    flowExpectedSignature: Pick<FlowRevision, 'id' | 'revision' | 'digest'>;
    flowConnectionBindings?: Record<string, string>;
}

export interface AgentFlowDraftInput {
    text: string;
    files: readonly File[];
    sourceScope?: ResourceScope;
    input?: import('../domain/input-draft').WorkspaceArgumentDraft;
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
        const result = await prepareDefinition(commands, flow, signal, trace, agent);
        recordPreparation(trace, result === null ? 'cancelled' : 'ready');
        return result;
    } catch (error) {
        if (signal.aborted) {recordPreparation(trace, 'cancelled'); return null;}
        recordPreparation(trace, 'failure', failureCategory(error));
        throw error;
    }
}

/** A published Flow is a root target, never a synthetic Agent wrapper. */
export async function prepareCallTarget(commands: ICommandBus, choice: RootCallTarget, signal: AbortSignal,
    draft: AgentFlowDraftInput): Promise<AgentFlowSubmission | null> {
    const trace = {stage: 'definition', started: Date.now(), operationId: randomUUID(), draft};
    recordPreparation(trace, 'start');
    try {
        const target = choice.target;
        const flow = await commands.execute<FlowRevision | null>(FlowCommand.RevisionGet, {id: target.id, revision: Number(target.version)});
        if (signal.aborted) return null;
        if (target.kind !== 'flow' || !flow || flow.id !== target.id || String(flow.revision) !== target.version || flow.digest !== target.digest)
            throw Object.assign(new Error(t('callable.catalog.changed')), {code: 'CALL_TARGET_CHANGED'});
        assertRootCallable(flow);
        if (draft.text && !/^\/run(?:\s|$)/.test(draft.text) && !flow.parameters?.some(field => field.inputSource === 'composer.text'))
            throw Object.assign(new Error(t('callable.input.unboundText')), {code: 'FLOW_INPUT_UNBOUND'});
        if (draft.files.length && !flow.parameters?.some(field => field.inputSource === 'composer.attachments'))
            throw Object.assign(new Error(t('callable.input.unboundFiles')), {code: 'FLOW_INPUT_UNBOUND'});
        const result = await prepareDefinition(commands, flow, signal, trace);
        recordPreparation(trace, result === null ? 'cancelled' : 'ready');
        return result;
    } catch (error) {
        if (signal.aborted) return null;
        recordPreparation(trace, 'failure', failureCategory(error)); throw error;
    }
}

async function prepareDefinition(commands: ICommandBus, flow: FlowRevision, signal: AbortSignal,
    trace: AgentFlowTrace, agent?: ExecutorOption): Promise<AgentFlowSubmission | null> {
    const execution = agent?.execution?.kind === 'flow' ? agent.execution : undefined;
    trace.stage = 'input';
    const scope = trace.draft?.sourceScope ?? {navigation: 'projects'};
    const command = trace.draft?.text.match(/^\/run(?:\s+([\s\S]*))?$/);
    const supplied = command ? await resolveFlowArguments(command[1] ?? '', flow.parameters ?? [], commands, scope, signal) : execution?.parameters;
    const {parameters, initialFiles} = confirmedFlowInput(flow, command ? {...trace.draft!, text: '', input: undefined} : trace.draft, supplied);
    const sources = new ParameterSources(commands, scope, parameters);
    trace.stage = 'connections';
    const connection = await flowConnectionSelection(commands, undefined, flow.connections, execution?.connectionBindings, flow, agent);
    if (signal.aborted) return null;
    trace.stage = 'parameters';
    const composite = !!agent?.composition && !parameters.length && !flow.connections?.length;
    if (composite) {await connection.validate?.(); await validateComposerFiles(trace.draft?.files ?? [], {}, signal);}
    const values = composite ? {} : await promptFlowParameters(parameters, `${agent?.name ?? flow.name} · ${t('agent.execution.runParameters')}`,
        values => validateComposerFiles(trace.draft?.files ?? [], values, signal), signal, connection, undefined,
        t('flow.launch.reviewInputs'), {mount: root => sources.mount(root), validate: () => sources.validate(), initialFiles, inputGroups: flow.inputGroups, submitLabel: 'flow.launch.start'});
    return values === null || signal.aborted ? null : {flowParameters: values,
        flowExpectedSignature: {id: flow.id, revision: flow.revision, digest: flow.digest},
        flowConnectionBindings: connection.bindings, connectionId: connection.selected};
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
