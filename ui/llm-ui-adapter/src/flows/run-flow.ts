import { flowConnectionSelection } from './connection-selection';
import { t } from '@itookit/common';
import { type FlowDraft, type FlowRevision, type JsonValue } from '@itookit/llm-flow/contracts';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { assertRootCallable, CallableExposureError } from '@itookit/llm-flow/contracts';
import { promptFlowParameters, type FlowConnectionSelection } from '../components/FlowParameterForm';

function assertLaunchScope(flow: FlowDraft | FlowRevision): void {
    try {assertRootCallable(flow);}
    catch (error) {
        if (!(error instanceof CallableExposureError)) throw error;
        throw Object.assign(new Error(t(error.code === 'CALLABLE_LOCAL_ONLY'
            ? 'callable.exposure.rootDenied' : 'callable.exposure.invalid')), {code: error.code});
    }
}

export interface FlowRunInput {
    parameters: Record<string, JsonValue>;
    connection: FlowConnectionSelection;
    signal?: AbortSignal;
}

export interface FlowRunOptions {
    commands: ICommandBus;
    navigate(sessionId: string): void | Promise<void>;
    prompt?: typeof promptFlowParameters;
}

/** One launcher is shared by the file menu and the design toolbar. */
export class FlowLauncher {
    private pending = false;
    constructor(private readonly options: FlowRunOptions) {}

    async run(flowId: string, revision?: number, input?: FlowRunInput): Promise<void> {
        if (this.pending) return;
        this.pending = true;
        try { await this.launch(flowId, revision, input); }
        finally { this.pending = false; }
    }

    private async launch(flowId: string, revision?: number, input?: FlowRunInput): Promise<void> {
        if (input?.signal?.aborted) return;
        const { commands } = this.options;
        const flow = await commands.execute<FlowDraft | FlowRevision | null>(
            revision === undefined ? FlowCommand.DraftLoad : FlowCommand.RevisionGet,
            { id: flowId, ...(revision === undefined ? {} : { revision }) });
        if (input?.signal?.aborted) return;
        if (!flow?.id) throw new Error(t('flow.launch.invalid'));
        assertLaunchScope(flow);
        const connection = input?.connection ?? await flowConnectionSelection(commands, undefined, flow.connections, undefined, flow);
        const values = input?.parameters ?? await (this.options.prompt ?? promptFlowParameters)(flow.parameters ?? [], undefined, undefined, undefined, connection);
        if (values === null) return;
        const published = revision === undefined
            ? (await commands.execute<{ revision: FlowRevision }>(FlowCommand.RevisionCreate,
                { draftId: flow.id, expectedDraftVersion: (flow as FlowDraft).draftVersion })).revision
            : flow as FlowRevision;
        if (input?.signal?.aborted) return;
        await this.createSession(published, values, connection.selected, connection.bindings, input?.signal);
    }

    private async createSession(flow: FlowRevision, parameters: Record<string, JsonValue>, connectionId?: string, connectionBindings?: Record<string, string>, signal?: AbortSignal): Promise<void> {
        const created = await this.options.commands.execute<{ sessionId: string }>(SessionCommand.CreateFromFlow, {
            flowId: flow.id, revision: flow.revision, parameters, title: flow.name,
            expectedSignature: {id: flow.id, revision: flow.revision, digest: flow.digest},
            invocation: true, connectionId, ...(Object.keys(connectionBindings ?? {}).length ? { connectionBindings } : {}),
        });
        if (!signal?.aborted) await this.options.navigate(created.sessionId);
    }
}

export function flowIdFromNodeId(nodeId: string | undefined): string | null {
    const base = nodeId?.split('/').pop() ?? '';
    return base.toLowerCase().endsWith('.flow') ? base.slice(0, -5) || null : null;
}
