import { flowConnectionSelection } from './connection-selection';
import { t } from '@itookit/common';
import { type FlowDraft, type FlowRevision, type JsonValue } from '@itookit/llm-flow/contracts';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { promptFlowParameters } from '../components/FlowParameterForm';

export interface FlowRunOptions {
    commands: ICommandBus;
    navigate(sessionId: string): void | Promise<void>;
    prompt?: typeof promptFlowParameters;
}

/** One launcher is shared by the file menu and the design toolbar. */
export class FlowLauncher {
    private pending = false;
    constructor(private readonly options: FlowRunOptions) {}

    async run(flowId: string, revision?: number): Promise<void> {
        if (this.pending) return;
        this.pending = true;
        try { await this.launch(flowId, revision); }
        finally { this.pending = false; }
    }

    private async launch(flowId: string, revision?: number): Promise<void> {
        const { commands } = this.options;
        const flow = await commands.execute<FlowDraft | FlowRevision | null>(
            revision === undefined ? FlowCommand.DraftLoad : FlowCommand.RevisionGet,
            { id: flowId, ...(revision === undefined ? {} : { revision }) });
        if (!flow?.id) throw new Error(t('flow.launch.invalid'));
        const connection = await flowConnectionSelection(commands);
        const values = await (this.options.prompt ?? promptFlowParameters)(flow.parameters ?? [], undefined, undefined, undefined, connection);
        if (values === null) return;
        const published = revision === undefined
            ? (await commands.execute<{ revision: FlowRevision }>(FlowCommand.RevisionCreate,
                { draftId: flow.id, expectedDraftVersion: (flow as FlowDraft).draftVersion })).revision
            : flow as FlowRevision;
        await this.createSession(published, values, connection.selected);
    }

    private async createSession(flow: FlowRevision, parameters: Record<string, JsonValue>, connectionId?: string): Promise<void> {
        const created = await this.options.commands.execute<{ sessionId: string }>(SessionCommand.CreateFromFlow, {
            flowId: flow.id, revision: flow.revision, parameters, title: flow.name,
            invocation: true, connectionId,
        });
        await this.options.navigate(created.sessionId);
    }
}

export function flowIdFromNodeId(nodeId: string | undefined): string | null {
    const base = nodeId?.split('/').pop() ?? '';
    return base.toLowerCase().endsWith('.flow') ? base.slice(0, -5) || null : null;
}
