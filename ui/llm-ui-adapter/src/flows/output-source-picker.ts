import {randomUUID, t} from '@itookit/common';
import {InputSourceCommand, type InputSourceExecution, type InputSourceReceipt, type ResourceScope} from '@itookit/app-contracts';
import {FlowCommand, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {DagWorkbench} from '../components/DagWorkbench';
import {sourceValues, type SourceValue} from './source-output';
import {sourceExecutionForm} from './source-execution-form';
import {runLabel} from './run-presentation';
import type {Run} from './session-output';

export function pickOutputSource(commands: ICommandBus, scope: ResourceScope, signal: AbortSignal): Promise<SourceValue | null> {
    return new OutputSourcePicker(commands, scope, signal).open();
}
class OutputSourcePicker {
    private dialog = document.createElement('dialog'); private abort = new AbortController();
    private runs = document.createElement('select'); private values = document.createElement('select');
    private status = document.createElement('p'); private preview = document.createElement('pre');
    private viewer = document.createElement('div'); private workbench?: DagWorkbench;
    private options: Run[] = []; private output: SourceValue[] = []; private result: SourceValue | null = null;
    private receipt?: InputSourceReceipt; private request?: InputSourceExecution; private busy = false; private unresolved = false;
    constructor(private commands: ICommandBus, private scope: ResourceScope, private signal: AbortSignal) {}
    open(): Promise<SourceValue | null> {
        if (this.signal.aborted) return Promise.resolve(null);
        this.dialog.className = 'dag-dialog flow-source-dialog';
        const title = document.createElement('h2'); title.textContent = t('flow.source.output'); this.status.setAttribute('role', 'status');
        this.runs.setAttribute('aria-label', t('flow.runs.title')); this.values.setAttribute('aria-label', t('flow.source.value'));
        const menu = document.createElement('div'); menu.append(this.button('flow.source.refresh', () => this.load()), this.button('flow.source.prepare', () => this.read()));
        for (const kind of ['tool', 'mcp', 'flow'] as const) menu.append(this.button(`flow.source.${kind}`, () => this.start(kind)));
        menu.append(this.button('flow.source.reconcile', () => this.reconcile()));
        const use = this.button('flow.source.use', async () => {const value = this.output[Number(this.values.value)]; if (value) {this.result = value; this.dialog.close();}});
        const close = this.button('flow.transcript.close', async () => {});
        close.onclick = () => this.dialog.close();
        this.values.onchange = () => this.showValue(); this.runs.onchange = () => {this.receipt = this.options[Number(this.runs.value)]; this.clearOutput();};
        this.dialog.append(title, this.runs, menu, this.status, this.values, this.preview, use, close, this.viewer);
        return new Promise(resolve => {
            const abort = () => this.dialog.close(); this.signal.addEventListener('abort', abort, {once: true});
            this.dialog.addEventListener('close', () => {this.abort.abort(); this.workbench?.destroy(); this.signal.removeEventListener('abort', abort); this.dialog.remove(); resolve(this.signal.aborted ? null : this.result);}, {once: true});
            document.body.append(this.dialog); this.dialog.showModal(); void this.perform(() => this.load());
        });
    }
    private button(key: Parameters<typeof t>[0], action: () => Promise<void>): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t(key);
        button.onclick = () => {void this.perform(action);}; return button;
    }
    private async perform(action: () => Promise<void>): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return;
        this.busy = true; this.status.textContent = t('flow.source.preparing');
        try {await action(); if (!this.abort.signal.aborted) this.status.textContent = '';}
        catch (error) {if (!this.abort.signal.aborted) this.status.textContent = error instanceof Error ? error.message : String(error);}
        finally {this.busy = false;}
    }
    private async load(): Promise<void> {
        const runs = await this.commands.execute<Run[]>(FlowCommand.RunList);
        if (this.abort.signal.aborted) return;
        this.options = runs; this.runs.replaceChildren(...runs.map((run, index) => new Option(runLabel(run), String(index))));
        if (!this.receipt) this.receipt = runs[0];
        const selected = runs.findIndex(run => run.taskId === this.receipt?.taskId); this.runs.value = String(selected);
    }
    private clearOutput(): void {this.output = []; this.values.replaceChildren(); this.preview.textContent = '';}
    private async read(): Promise<void> {
        this.clearOutput(); const receipt = this.receipt;
        if (!receipt?.taskId) throw new Error(t('flow.source.noResult'));
        const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, receipt);
        if (this.abort.signal.aborted || receipt !== this.receipt) return;
        if (snapshot.root.task.id !== receipt.taskId || snapshot.root.task.sessionId !== receipt.sessionId) throw new Error('SOURCE_SCOPE_MISMATCH');
        this.output = sourceValues(snapshot); this.values.replaceChildren(...this.output.map((value, index) => new Option(value.label, String(index)))); this.showValue();
    }
    private showValue(): void {const value = this.output[Number(this.values.value)]?.value; this.preview.textContent = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);}
    private async start(kind: 'tool' | 'mcp' | 'flow'): Promise<void> {
        if (this.unresolved) throw new Error(t('flow.source.reconcileRequired'));
        const source = await sourceExecutionForm(this.commands, kind, this.abort.signal);
        if (!source || this.abort.signal.aborted) return;
        this.clearOutput(); this.receipt = undefined;
        this.request = {requestId: randomUUID(), scope: {...this.scope}, source};
        this.unresolved = true;
        this.receipt = await this.commands.execute<InputSourceReceipt>(InputSourceCommand.Execute, this.request);
        this.unresolved = !this.receipt?.taskId;
        if (!this.abort.signal.aborted) await this.showExecution();
    }
    private async reconcile(): Promise<void> {
        if (!this.request) return;
        this.receipt = await this.commands.execute<InputSourceReceipt | undefined>(InputSourceCommand.Inspect, {requestId: this.request.requestId});
        if (!this.receipt?.taskId) throw new Error(t('flow.source.noResult'));
        this.unresolved = false;
        if (!this.abort.signal.aborted) await this.showExecution();
    }
    private async showExecution(): Promise<void> {
        if (!this.receipt?.taskId) return;
        this.workbench?.destroy(); this.viewer.replaceChildren();
        this.workbench = new DagWorkbench(this.viewer, {commands: this.commands, hideBackButton: true});
        await this.workbench.openRun(this.receipt.taskId, this.receipt.sessionId); await this.load();
    }
}
