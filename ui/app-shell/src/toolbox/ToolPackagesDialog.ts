import {createModuleLogger, escapeHTML, randomUUID, t, type LocaleKey} from '@itookit/common';
import type {FlowInstallationReport, FlowInstallations, ToolPackageInfo, ToolPackages} from '@itookit/app-contracts/services';
import {sourceConnectionSettings, importConnection, connectionInput, type SourceConnections} from '../configuration/tool-connections';

interface PackageControls {toolPackages?: ToolPackages; flowInstallations?: FlowInstallations}
const log = createModuleLogger('tool-package-ui');
const label = (key: string) => t(`toolbox.packages.${key}` as LocaleKey);

/** Package locations and executable discovery stay behind the trusted host port. */
export function showToolPackages(controls: PackageControls, signal?: AbortSignal, changed: () => Promise<void> = async () => {}): Promise<void> {
    return new ToolPackagesDialog(controls, changed).open(signal);
}

class ToolPackagesDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly body = document.createElement('div');
    private packages: ToolPackageInfo[] = [];
    private flows: FlowInstallationReport[] = [];
    private connectionState: SourceConnections = {types: [], connections: []};
    private busy = false;
    private disposed = false;
    private error = '';
    private outcome = 'success';
    private authorizationTimer?: ReturnType<typeof setTimeout>;
    constructor(private readonly controls: PackageControls, private readonly changed: () => Promise<void>) {}

    open(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.resolve();
        const origin = document.activeElement;
        this.dialog.className = 'tool-packages-dialog'; this.dialog.setAttribute('aria-label', label('title'));
        this.body.className = 'tool-packages-dialog__body'; this.body.tabIndex = 0;
        const header = document.createElement('header'), title = document.createElement('h2'); title.textContent = label('title');
        const close = document.createElement('button'); close.type = 'button'; close.textContent = t('action.close'); close.onclick = () => this.dialog.close();
        header.append(title, close); this.dialog.append(header, this.body); document.body.append(this.dialog);
        this.body.onclick = event => this.click(event); this.dialog.showModal(); void this.refresh();
        this.body.onsubmit = event => {event.preventDefault(); const form = event.target as HTMLFormElement; if (form.dataset.form === 'sourceConnection') void this.saveConnection(form);};
        this.body.onchange = event => {
            const input = event.target;
            if (input instanceof HTMLInputElement && input.name === 'connectionImport') void importConnection(input).catch(() => {
                if (!this.disposed) this.body.querySelector('[role=alert]')!.textContent = t('toolbox.connections.connectionImportInvalid');
            });
        };
        return new Promise(resolve => {
            const abort = () => this.dialog.close(); signal?.addEventListener('abort', abort, {once: true});
            this.dialog.addEventListener('close', () => {
                this.disposed = true; clearTimeout(this.authorizationTimer); signal?.removeEventListener('abort', abort); this.dialog.remove();
                if (origin instanceof HTMLElement && origin.isConnected) origin.focus(); resolve();
            }, {once: true});
        });
    }

    private click(event: MouseEvent): void {
        const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
        if (!target || this.busy || this.disposed) return;
        if (target.dataset.authBegin) {void this.authorize(target.closest('form')!); return;}
        if (target.dataset.authCancel) {void this.run('tool.authorization.cancel', async () => {await this.controls.toolPackages?.connections?.cancelAuthorization?.(target.dataset.authCancel!); await this.readState();}); return;}
        if (target.dataset.authRevoke) {void this.run('tool.authorization.revoke', async () => {await this.controls.toolPackages?.connections?.revokeAuthorization?.(target.dataset.authRevoke!); await this.readState();}); return;}
        if (target.hasAttribute('data-packages-refresh')) void this.refresh();
        const packageId = target.dataset.packageEnsure;
        if (packageId) {const item = this.packages.find(item => item.id === packageId); if (item) void this.register(item);}
        if (target.dataset.flowCheck) void this.flowAction(target.dataset.flowCheck, false);
        if (target.dataset.flowEnsure) void this.flowAction(target.dataset.flowEnsure, true);
        if (target.dataset.packageFlows) {
            const item = this.packages.find(item => item.id === target.dataset.packageFlows && item.version === target.dataset.packageVersion);
            if (item) void this.run('tool.resources.install', async () => {
                await this.controls.toolPackages?.installFlows?.(item.id, item.version); await this.readState(); if (!this.disposed) await this.changed();
            });
        }
        if (target.dataset.action === 'removeSourceConnection') void this.run('tool.connection.remove', async () => {
            await this.controls.toolPackages?.connections?.remove(target.dataset.id!); await this.readState();
        });
    }

    private async refresh(): Promise<void> {
        await this.run('tool.packages.check', () => this.readState());
    }

    private async readState(): Promise<void> {
        const results = await Promise.allSettled([this.controls.toolPackages?.list() ?? [], this.controls.flowInstallations?.list() ?? [],
            this.controls.toolPackages?.connections?.snapshot() ?? {types: [], connections: []}]);
        if (this.disposed) return;
        const [packages, flows, connections] = results;
        if (packages.status === 'fulfilled') this.packages = packages.value;
        if (flows.status === 'fulfilled') this.flows = flows.value;
        if (connections.status === 'fulfilled') this.connectionState = connections.value;
        this.error = [this.error, ...results.flatMap(result => result.status === 'rejected' ? [reason(result.reason)] : [])].filter(Boolean).join('；');
    }

    private async saveConnection(form: HTMLFormElement): Promise<void> {
        const input = connectionInput(form);
        await this.run('tool.connection.save', async () => {await this.controls.toolPackages?.connections?.save(input); await this.readState();});
    }
    private async authorize(form: HTMLFormElement): Promise<void> {
        if (!form.reportValidity()) return;
        const input = connectionInput(form), groups = [...form.querySelectorAll<HTMLInputElement>('[data-auth-group]:checked')].map(field => field.value);
        await this.run('tool.authorization.begin', async operationId => {
            const port = this.controls.toolPackages?.connections;
            if (!port?.beginAuthorization) throw new Error('TOOL_AUTH_UNSUPPORTED');
            await port.save(input); await port.beginAuthorization(input.id, groups, operationId); await this.readState();
        });
    }
    private pollAuthorizations(): void {
        clearTimeout(this.authorizationTimer);
        if (this.disposed || !this.connectionState.connections.some(connection => ['pending', 'exchanging'].includes(connection.authorization?.operation?.status ?? ''))) return;
        this.authorizationTimer = setTimeout(() => {void this.refreshAuthorizations();}, 1000);
    }
    private async refreshAuthorizations(): Promise<void> {
        if (this.disposed) return;
        if (this.busy) {this.pollAuthorizations(); return;}
        const port = this.controls.toolPackages?.connections; if (!port?.authorizationStatus) return;
        try {
            const operations = this.connectionState.connections.flatMap(connection => {
                const operation = connection.authorization?.operation; return operation && ['pending', 'exchanging'].includes(operation.status) ? [operation] : [];
            });
            const states = await Promise.all(operations.map(operation => port.authorizationStatus!(operation.operationId)));
            if (this.disposed) return;
            for (const state of states) {
                const connection = this.connectionState.connections.find(connection => connection.id === state.connectionId);
                if (connection?.authorization) connection.authorization.operation = state;
                const status = [...this.body.querySelectorAll<HTMLElement>('[data-authorization-status]')].find(node => node.dataset.authorizationStatus === state.connectionId);
                if (status) status.textContent = t(`toolbox.connections.authState.${state.status}` as LocaleKey) + (state.code ? ' · ' + state.code : '');
            }
            if (states.some(state => !['pending', 'exchanging'].includes(state.status))) {await this.readState(); if (!this.disposed) this.render();}
        } catch {if (!this.disposed) {this.error = 'TOOL_AUTH_STATUS_UNAVAILABLE'; await this.readState(); if (!this.disposed) this.render();}}
        this.pollAuthorizations();
    }

    private async register(item: ToolPackageInfo): Promise<void> {
        await this.run('tool.packages.prepare', async () => {
            const result = await this.controls.toolPackages!.ensure(item.tools);
            if (this.disposed) return;
            this.error = result.tools.filter(tool => tool.status !== 'ready').map(tool => `${tool.id}: ${tool.reason || t('flow.dependencies.missingTools')}`).join('；');
            await this.readState(); if (!this.disposed) await this.changed();
        });
    }

    private async flowAction(id: string, prepare: boolean): Promise<void> {
        await this.run(prepare ? 'flow.dependencies.prepare' : 'flow.dependencies.check', async () => {
            const report = await this.controls.flowInstallations![prepare ? 'ensure' : 'check'](id);
            if (this.disposed) return;
            this.outcome = report.status;
            this.flows = this.flows.map(item => item.flowId === report.flowId ? report : item);
            await this.readState(); if (!this.disposed) await this.changed();
        });
    }

    private async run(operation: string, execute: (operationId: string) => Promise<void>): Promise<void> {
        if (this.busy || this.disposed) return;
        const started = performance.now(), operationId = randomUUID(); this.busy = true; this.error = ''; this.outcome = 'success'; this.render();
        log.info('dependencies.started', {operation, operationId, stage: 'request', result: 'start'});
        try {
            await execute(operationId);
            log.info('dependencies.completed', {operation, operationId, stage: 'result', result: this.error ? 'partial' : this.outcome, durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            if (!this.disposed) this.error = reason(error);
            log.error('dependencies.failed', {operation, operationId, stage: 'request', result: 'failure', code: 'DEPENDENCY_REQUEST_FAILED', errorType: error instanceof Error ? error.name : typeof error,
                durationMs: Math.round(performance.now() - started)});
        } finally {this.busy = false; if (!this.disposed) this.render();}
    }

    private render(): void {
        const scroll = this.body.scrollTop;
        this.body.innerHTML = `<p>${escapeHTML(label('help'))}</p><div class="tool-packages-dialog__actions">
            <button type="button" data-packages-refresh ${this.busy ? 'disabled' : ''}>${escapeHTML(t('action.refresh'))}</button>
            <span role="status">${this.busy ? escapeHTML(label('loading')) : ''}</span></div>
            <p class="tool-packages-dialog__error" role="alert">${escapeHTML(this.error)}</p>
            <section class="tool-packages-dialog__section">${this.packages.length ? this.packages.map(item => packageRow(item, this.busy)).join('') : `<p>${escapeHTML(label('empty'))}</p>`}</section>
            ${this.controls.toolPackages?.connections ? sourceConnectionSettings(this.connectionState, true) : ''}
            ${this.controls.flowInstallations ? `<section class="tool-packages-dialog__section"><h3>${escapeHTML(label('flows'))}</h3>${this.flows.map(item => flowRow(item, this.busy)).join('')}</section>` : ''}`;
        this.body.scrollTop = scroll;
        this.pollAuthorizations();
    }
}

function packageRow(item: ToolPackageInfo, busy: boolean): string {
    const action = (item.status === 'available' || item.status === 'failed' ? `<button type="button" data-package-ensure="${escapeHTML(item.id)}" ${busy ? 'disabled' : ''}>${escapeHTML(label(item.status === 'failed' ? 'retry' : 'register'))}</button>` : '')
        + (item.flowCount && item.status === 'registered' ? `<button type="button" data-package-flows="${escapeHTML(item.id)}" data-package-version="${escapeHTML(item.version)}" ${busy ? 'disabled' : ''}>${escapeHTML(label('installFlows'))} (${item.flowCount})</button>` : '');
    return `<article class="tool-packages-dialog__item" data-package-id="${escapeHTML(item.id)}"><div class="tool-packages-dialog__item-header">
        <strong>${escapeHTML(item.name || item.id)}</strong><span>${escapeHTML(item.version)}</span><span data-package-status>${escapeHTML(label(item.status))}</span></div>
        ${item.description ? `<p>${escapeHTML(item.description)}</p>` : ''}
        <p><code>${escapeHTML(item.tools.map(tool => tool.id + (tool.version ? '@' + tool.version : '')).join(', '))}</code></p>
        ${item.reason || item.status === 'missing' ? `<p>${escapeHTML(item.reason || label('missingHint'))}</p>` : ''}${action}</article>`;
}

function flowRow(report: FlowInstallationReport, busy: boolean): string {
    const tools = report.tools.filter(tool => tool.status !== 'ready').map(tool => `${tool.id}${tool.version ? '@' + tool.version : ''}: ${tool.reason || t('flow.dependencies.missingTools')}`);
    const issues = [...tools, ...report.parameters, ...report.connections, ...report.errors].map(issue => typeof issue === 'string' ? issue : `${issue.field ? issue.field + ': ' : ''}${issue.message}`);
    return `<article class="tool-packages-dialog__item" data-flow-id="${escapeHTML(report.flowId)}"><div class="tool-packages-dialog__item-header">
        <strong>${escapeHTML(report.name || report.flowId)}</strong><span>${escapeHTML(t(`flow.dependencies.${report.status}` as LocaleKey))}</span></div>
        ${issues.length ? `<ul>${issues.map(issue => `<li>${escapeHTML(issue)}</li>`).join('')}</ul>` : ''}
        <div class="tool-packages-dialog__actions"><button type="button" data-flow-check="${escapeHTML(report.flowId)}" ${busy ? 'disabled' : ''}>${escapeHTML(label('check'))}</button>
        ${report.status !== 'ready' ? `<button type="button" data-flow-ensure="${escapeHTML(report.flowId)}" ${busy ? 'disabled' : ''}>${escapeHTML(label('prepare'))}</button>` : ''}</div></article>`;
}

function reason(error: unknown): string {return error instanceof Error ? error.message : String(error);}
