import {createModuleLogger, t} from '@itookit/common';
import {FlowCommand, formatFlowOutput, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import type {ICommandBus, IndependentCallView} from '@itookit/llm-session/contracts';
import {FlowDocuments, flowRequestMarkdown} from './FlowDocuments';
import {openSessionFlowOutputs} from '../../flows/session-output';

/** Independent Flow calls show their request and result, with explicit access to node detail. */
export class FlowCallDocument {
    private documents = new FlowDocuments();
    private abort = new AbortController();
    private key = '';
    private result?: string;
    private generation = 0;
    private readonly detail = document.createElement('button');
    private readonly body = document.createElement('div');
    private readonly retry = document.createElement('button');
    constructor(private root: HTMLElement, private commands: ICommandBus) {
        this.retry.dataset.flowResultRetry = ''; this.retry.type = 'button'; this.retry.hidden = true; this.retry.textContent = t('flow.document.retry');
        this.detail.type = 'button'; this.detail.textContent = t('flow.invoke.details'); root.append(this.body, this.detail, this.retry);
    }
    update(call: IndependentCallView): void {
        const {executionSessionId, execution} = call.receipt;
        this.detail.hidden = !executionSessionId || !execution;
        this.detail.onclick = () => openSessionFlowOutputs(this.commands, executionSessionId!, this.abort.signal, execution!.taskId);
        this.render(call, this.result ?? call.summary ?? t('flow.output.pending'));
        if (!executionSessionId || !execution || !['completed', 'failed', 'cancelled'].includes(call.status ?? '')) return;
        const key = JSON.stringify([executionSessionId, execution.taskId, call.status]);
        if (key === this.key) return;
        this.key = key;
        void this.read(call, executionSessionId, execution.taskId, ++this.generation);
    }
    private async read(call: IndependentCallView, sessionId: string, taskId: string, generation: number): Promise<void> {
        const started = Date.now(); this.retry.hidden = true;
        try {
            const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId, taskId});
            if (generation !== this.generation || this.abort.signal.aborted) return;
            const task = snapshot.root.task;
            if (task.sessionId !== sessionId || task.id !== taskId) throw new Error('Flow result scope mismatch');
            const output = task.output as {nodes?: Record<string, unknown>} | undefined;
            this.result = formatFlowOutput(output?.nodes?.__flow_return ?? output ?? task.exit?.error ?? '');
            this.render(call, this.result);
        } catch (error) {
            if (generation !== this.generation || this.abort.signal.aborted) return;
            this.retry.hidden = false; this.retry.onclick = () => {if (!this.abort.signal.aborted) void this.read(call, sessionId, taskId, ++this.generation);};
            this.render(call, `${call.summary ?? ''}\n\n${t('flow.document.failed')}`);
            createModuleLogger('flow-call-document').warn('flow.call.read', {operationId: call.receipt.operationId,
                sessionId, taskId, stage: 'result', result: 'failure', code: 'FLOW_CALL_RESULT_READ_FAILED', durationMs: Date.now() - started});
        }
    }
    private render(call: IndependentCallView, result: string): void {
        this.documents.mount(this.body, call.receipt.operationId, t('flow.invoke.result'),
            `## ${t('flow.invoke.inputs')}\n\n${flowRequestMarkdown(call.input.request.source)}\n\n## ${t('flow.invoke.result')}\n\n${result}`);
    }
    setVisible(visible: boolean): void {
        if (!visible) {this.generation++; this.key = ''; this.abort.abort();}
        else if (this.abort.signal.aborted) this.abort = new AbortController();
    }
    destroy(): void {this.generation++; this.abort.abort(); this.documents.destroy(); this.root.remove();}
}
