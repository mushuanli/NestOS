import {createModuleLogger, randomUUID, t} from '@itookit/common';
import type {AgentPublicationStatus, AgentPublishRequest, AgentPublishedRevision, IAgentManagementService} from '@itookit/kernel-adapters/contracts';

const log = createModuleLogger('agent-publication');

/** Independent publication controls retain their request when a write reply is unknown. */
export class AgentPublicationController {
    private readonly publish = document.createElement('button');
    private readonly inspect = document.createElement('button');
    private readonly status = document.createElement('span');
    private pending?: AgentPublishRequest;
    private active?: string;
    private busy = false;
    private disposed = false;
    private observation = 0;
    private sent?: string;
    private uncertain = false;
    private sourceRefreshRequired = false;
    constructor(private root: HTMLElement, private service: IAgentManagementService, private agentId: string,
        private flush: () => Promise<void>, private readOnly: boolean) {
        root.hidden = !service.publishAgent || !service.getAgentPublicationStatus || !service.getAgentPublicationReceipt;
        if (root.hidden) return;
        this.publish.type = this.inspect.type = 'button'; this.publish.dataset.agentPublish = ''; this.inspect.dataset.agentPublicationInspect = '';
        this.status.className = 'agent-publication__status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        root.append(this.status, this.publish, this.inspect);
        this.publish.onclick = () => {void this.run();}; this.inspect.onclick = () => {void this.refresh();};
        this.paint(); void this.refresh();
    }
    get hasPendingWrite(): boolean {return !!this.pending && this.sent === this.pending.operationId;}
    requireSourceReview(): void {this.sourceRefreshRequired = true; this.paint();}
    assertCanClose(): void {if (this.hasPendingWrite) throw new Error(t('agent.publication.pendingLeave'));}
    destroy(): void {this.disposed = true; this.active = undefined; this.root.replaceChildren();}

    private paint(): void {
        this.publish.textContent = t(this.pending ? 'agent.publication.retry' : 'agent.publication.publish');
        this.publish.disabled = this.disposed || this.readOnly || this.busy || this.sourceRefreshRequired && !this.pending;
        this.inspect.textContent = t(this.pending ? 'agent.publication.reconcile' : 'agent.publication.refresh');
        this.inspect.disabled = this.disposed;
    }
    private async refresh(): Promise<void> {
        const operationId = this.pending?.operationId ?? randomUUID(), started = Date.now(), observation = ++this.observation;
        try {
            const request = this.pending;
            if (request) await this.inspectReceipt(request, observation);
            else {
                const state = await this.service.getAgentPublicationStatus!(this.agentId);
                if (this.canShowState(observation)) this.showState(state);
            }
            this.report(operationId, 'inspect', started);
        } catch (error) {if (this.currentObservation(observation)) this.failure(operationId, 'inspect', started, error);}
        finally {this.paint();}
    }
    private currentObservation(observation: number): boolean {return !this.disposed && observation === this.observation;}
    private canShowState(observation: number): boolean {return this.currentObservation(observation) && !this.pending && !this.busy;}
    private async inspectReceipt(request: AgentPublishRequest, observation: number): Promise<void> {
        const receipt = await this.service.getAgentPublicationReceipt!(structuredClone(request));
        if (this.disposed || observation !== this.observation || this.pending?.operationId !== request.operationId) return;
        if (receipt) this.accept(request, receipt); else this.status.textContent = t('agent.publication.unknown');
    }
    private async run(): Promise<void> {
        if (!this.available()) return;
        const operationId = this.pending?.operationId ?? randomUUID(), started = Date.now(), wasUncertain = this.uncertain; let stage = 'save';
        this.active = operationId; this.busy = true; this.observation++; this.paint();
        try {
            const request = await this.preparedRequest(operationId, next => {stage = next;});
            if (!request) return;
            stage = 'receipt';
            const prior = await this.service.getAgentPublicationReceipt!(request);
            if (!this.current(operationId)) return;
            if (prior) {this.accept(request, prior); return;}
            stage = 'publish'; this.sent = operationId; const revision = await this.service.publishAgent!(request);
            if (this.current(operationId)) this.accept(request, revision);
            this.report(operationId, stage, started);
        } catch (error) {
            this.failedRun(operationId, wasUncertain, stage, started, error);
        } finally {if (this.active === operationId) this.busy = false; this.paint();}
    }
    private available(): boolean {return !this.disposed && !this.readOnly && !this.busy;}
    private async preparedRequest(id: string, stage: (value: string) => void): Promise<AgentPublishRequest | undefined> {
        if (!this.pending) await this.prepare(id, stage);
        return this.current(id) && this.pending ? structuredClone(this.pending) : undefined;
    }
    private failedRun(id: string, wasUncertain: boolean, stage: string, started: number, error: unknown): void {
        if (!this.current(id)) return;
        if (this.sent !== id || !wasUncertain && (error as {outcome?: string})?.outcome === 'not-committed') this.pending = undefined;
        else this.uncertain = true;
        this.failure(id, stage, started, error);
    }
    private async prepare(operationId: string, stage: (value: string) => void): Promise<void> {
        if (this.sourceRefreshRequired) throw Object.assign(new Error('Agent source must be reviewed again'), {code: 'AGENT_PUBLICATION_EDITOR_STALE'});
        stage('save'); await this.flush(); if (!this.current(operationId)) return;
        stage('prepare');
        const state = await this.service.getAgentPublicationStatus!(this.agentId);
        if (!this.current(operationId)) return;
        this.pending = {agentId: this.agentId, operationId, expectedSourceDigest: state.sourceDigest,
            expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: state.latest?.target.version ?? null};
    }
    private current(id: string): boolean {return !this.disposed && this.active === id;}
    private accept(request: AgentPublishRequest, revision: AgentPublishedRevision): void {
        if (this.pending?.operationId !== request.operationId) return;
        assertReceipt(request, revision);
        this.pending = undefined; this.active = undefined; this.sent = undefined; this.uncertain = false; this.busy = false; this.observation++;
        this.status.textContent = t('agent.publication.published', {version: revision.target.version.slice(0, 16)})
            + (this.sourceRefreshRequired ? ` · ${t('agent.publication.reviewRequired')}` : ''); this.paint();
    }
    private showState(state: AgentPublicationStatus): void {
        this.status.textContent = this.sourceRefreshRequired ? t('agent.publication.reviewRequired')
            : t(!state.latest ? 'agent.publication.legacy' : state.hasDraftChanges ? 'agent.publication.changed' : 'agent.publication.current');
    }
    private failure(operationId: string, stage: string, started: number, error: unknown): void {
        this.status.textContent = t('agent.publication.failed', {code: failureCode(error)});
        this.report(operationId, stage, started, error);
    }
    private report(operationId: string, stage: string, started: number, error?: unknown): void {
        const fields = {operation: 'agent.publish', operationId, stage, result: error ? 'failure' : 'success',
            code: error ? failureCode(error) : undefined, durationMs: Date.now() - started};
        if (error) log.warn('Agent publication', fields); else log.info('Agent publication', fields);
    }
}
function assertReceipt(request: AgentPublishRequest, revision: AgentPublishedRevision): void {
    if (revision?.schemaVersion !== 1 || revision.target?.kind !== 'agent' || revision.target.id !== request.agentId
        || revision.target.version !== `ap1_${request.expectedRevisionDigest}` || revision.target.digest !== request.expectedRevisionDigest
        || revision.sourceDigest !== request.expectedSourceDigest)
        throw Object.assign(new Error('Publication receipt differs from the frozen request'), {code: 'AGENT_PUBLICATION_RECEIPT_INVALID'});
}
function failureCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'AGENT_PUBLICATION_FAILED';
}
