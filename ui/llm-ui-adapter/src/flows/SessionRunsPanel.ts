import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {SessionCommand, type ICommandBus} from '@itookit/llm-session/contracts';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {openSessionFlowOutputs, unlinkedSessionRuns, type Branches, type Run} from './session-output';

import {runIdentity, runStatus, runTitle} from './run-presentation';

/** Observe standalone runs without inventing chat history or resuming execution. */
export class SessionRunsPanel {
    private readonly root = document.createElement('aside');
    private lifetime = new AbortController();
    private rendered = '';
    private timer?: ReturnType<typeof setTimeout>;
    private revision = 0;
    private active = true;
    private closed = false;
    constructor(private commands: ICommandBus, private sessionId: string, container: HTMLElement,
        private onRuns?: () => void, initiallyActive = true) {
        this.root.className = 'llm-session-runs'; this.root.hidden = true; container.append(this.root);
        this.active = initiallyActive; if (initiallyActive) void this.refresh();
    }
    async refresh(): Promise<void> {
        if (!this.active || this.closed) return;
        clearTimeout(this.timer);
        const revision = ++this.revision, operationId = randomUUID(), started = Date.now();
        try {
            const [runs, branches] = await Promise.all([
                this.commands.execute<Run[]>(FlowCommand.RunList, {sessionId: this.sessionId}),
                this.commands.execute<Branches>(SessionCommand.FlowBranchExecutions, {sessionId: this.sessionId}),
            ]);
            if (revision !== this.revision || !this.active || this.closed) return;
            this.render(unlinkedSessionRuns(runs, branches, this.sessionId));
        } catch (error) {
            if (revision !== this.revision || !this.active || this.closed) return;
            this.rendered = ''; this.root.hidden = false; this.root.textContent = `${t('flow.runs.title')}: ${error instanceof Error ? error.message : String(error)}`;
            createModuleLogger('session-runs').warn('session.runs.read', {operationId, sessionId: this.sessionId,
                stage: 'catalog', result: 'failure', code: 'SESSION_RUNS_READ_FAILED', durationMs: Date.now() - started});
        } finally {
            if (revision === this.revision && this.active && !this.closed) this.timer = setTimeout(() => {void this.refresh();}, 5000);
        }
    }
    private render(runs: Run[]): void {
        if (runs.length) this.onRuns?.();
        const signature = JSON.stringify(runs);
        if (signature === this.rendered) return;
        this.rendered = signature;
        const expanded = this.root.querySelector('details')?.open ?? false;
        this.root.replaceChildren(); this.root.hidden = !runs.length;
        if (!runs.length) return;
        const details = document.createElement('details'), title = document.createElement('summary');
        title.textContent = t('flow.runs.standalone', {count: runs.length}); details.open = expanded;
        const hint = document.createElement('p'); hint.textContent = t('flow.runs.separateHint');
        details.append(title, hint); this.root.append(details);
        for (const run of runs) this.renderRun(details, run);
    }
    private renderRun(parent: HTMLElement, run: Run): void {
        const row = document.createElement('section'), button = document.createElement('button'); button.type = 'button';
        const name = document.createElement('strong'), identity = document.createElement('small'), status = document.createElement('span');
        name.textContent = runTitle(run); name.title = run.name;
        identity.textContent = runIdentity(run); status.textContent = runStatus(run.status); status.dataset.status = run.status;
        button.append(name, identity, status); button.title = run.taskId;
        button.onclick = () => openSessionFlowOutputs(this.commands, this.sessionId, this.lifetime.signal, run.taskId);
        row.append(button); parent.append(row);
        if (run.status !== 'failed') return;
        const error = document.createElement('p'); error.className = 'llm-session-runs__error';
        error.textContent = run.failure ? t('flow.runs.failureReason', {reason: [run.failure.code, run.failure.message].filter(Boolean).join(': ')})
            : t('flow.runs.failureDetails');
        row.append(error);
    }

    setVisible(active: boolean): void {
        this.active = active; this.revision++; clearTimeout(this.timer);
        if (!active) this.lifetime.abort();
        else if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
        if (active) void this.refresh();
    }
    destroy(): void {
        this.closed = true; this.revision++; clearTimeout(this.timer); this.lifetime.abort(); this.root.remove();
    }
}
