import {packageConfiguration, readPackageSettings} from './package-configuration';
import {createModuleLogger, escapeHTML, randomUUID, t, type LocaleKey} from '@itookit/common';
import type {ToolPackageInfo, ToolPackages, ToolRunRecord} from '@itookit/app-contracts/services';
import {packageGuide} from './package-guide';
import {packageFlows, packageFlowKey} from './package-flows';
import {versionAction, packageVersions} from './package-versions';
import {connectionFeedback, revealConnection, type ConnectionNotice} from './connection-feedback';
import {verificationMessage} from '../configuration/connection-verification';
import {sourceConnectionSettings, importConnection, connectionInput, validateConnectionForm, type SourceConnections} from '../configuration/tool-connections';

interface PackageControls {toolPackages?: ToolPackages}
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
    private readonly histories = new Map<string, ToolRunRecord[]>();
    private readonly addedFlows = new Map<string, number>();
    private installingFlows?: string;
    private connectionState: SourceConnections = {types: [], connections: []};
    private busy = false;
    private disposed = false;
    private error = '';
    private outcome = 'success';
    private authorizationTimer?: ReturnType<typeof setTimeout>;
    private readonly connectionDrafts = new Map<string, string>();
    private readonly connectionNotices = new Map<string, ConnectionNotice>();
    private connectionToReveal?: string;
    private formEdited = false;
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
        this.body.addEventListener('input', event => {if ((event.target as Element).closest('form')) this.formEdited = true;});
        const stopPackages = this.controls.toolPackages?.onChange?.(() => {
            if (this.disposed || this.busy) return;
            if (this.formEdited) {const notice = this.body.querySelector('[data-package-version-notice]'); if (notice) notice.textContent = label('changedWhileEditing');}
            else void this.refresh();
        });
        this.dialog.addEventListener('close', () => stopPackages?.(), {once: true});
        this.body.onsubmit = event => {
            event.preventDefault(); const form = event.target as HTMLFormElement;
            if (form.dataset.form === 'sourceConnection') void this.saveConnection(form);
            else if (form.dataset.form === 'toolPackage') void this.savePackage(form);
            else if (form.dataset.form === 'oauthApplication') void this.saveApplication(form);
        };
        this.body.onchange = event => {
            const input = event.target;
            if (input instanceof HTMLSelectElement && input.hasAttribute('data-connection-method')) {
                for (const panel of input.closest('[data-connection-type]')!.querySelectorAll<HTMLDetailsElement>('[data-method-panel]')) {panel.hidden = panel.dataset.methodPanel !== input.value; if (!panel.hidden) panel.open = true;} return;
            }
            if (input instanceof HTMLInputElement && input.name === 'connectionImport') void importConnection(input).catch(error => {
                if (!this.disposed) this.body.querySelector('[role=alert]')!.textContent = reason(error);
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
        if (target.dataset.connectionVerify) {
            const id = target.dataset.connectionVerify, connection = this.connectionState.connections.find(item => item.id === id);
            if (connection) void this.run('tool.connection.verify', async () => {await this.verifyConnection(id, connection.type, id);});
            return;
        }
        if (target.dataset.applicationRemove) {void this.run('tool.application.remove', async () => {
            await this.controls.toolPackages?.connections?.removeApplication?.(target.dataset.applicationRemove!); await this.readState();
        }); return;}
        if (target.dataset.authBegin) {void this.authorize(target.closest('form')!); return;}
        if (target.dataset.authCancel) {void this.run('tool.authorization.cancel', async () => {await this.controls.toolPackages?.connections?.cancelAuthorization?.(target.dataset.authCancel!); await this.readState();}); return;}
        if (target.dataset.authRevoke) {void this.run('tool.authorization.revoke', async () => {await this.controls.toolPackages?.connections?.revokeAuthorization?.(target.dataset.authRevoke!); await this.readState();}); return;}
        if (target.hasAttribute('data-packages-refresh')) void this.refresh();
        if (target.dataset.packageSwitch) {
            const active = primaryPackages(this.packages).find(item => item.id === target.dataset.packageSwitch && item.version === target.dataset.expectedVersion);
            const selected = this.packages.find(item => item.id === active?.id && item.version === target.dataset.packageVersion && item.canSwitch);
            if (active && selected) void this.switchPackageVersion(active, selected);
            return;
        }
        if (target.dataset.packageToggle) {const item = primaryPackages(this.packages).find(item => item.id === target.dataset.packageToggle && item.configuration); if (item?.configuration) void this.run('tool.package.toggle', async () => {await this.controls.toolPackages?.configure?.(item.id, item.version, {enabled: !item.configuration!.enabled, defaults: item.configuration!.defaults, ...(item.configuration!.disabledTools ? {disabledTools: item.configuration!.disabledTools} : {})}); await this.readState(); if (!this.disposed) await this.changed();}); return;}
        if (target.dataset.packageHistory) {const item = primaryPackages(this.packages).find(item => item.id === target.dataset.packageHistory); if (item) void this.run('tool.history.read', async () => {this.histories.set(item.id, await this.controls.toolPackages?.history?.(item.id, item.version) ?? []);}); return;}
        if (target.dataset.packageUninstall) {const item = primaryPackages(this.packages).find(item => item.id === target.dataset.packageUninstall && item.version === target.dataset.packageVersion); if (item) void this.run('tool.package.uninstall', async () => {await this.controls.toolPackages?.uninstall?.(item.id, item.version); await this.readState(); if (!this.disposed) await this.changed();}); return;}
        const packageId = target.dataset.packageEnsure;
        if (packageId) {const item = primaryPackages(this.packages).find(item => item.id === packageId); if (item) void this.register(item);}
        if (target.dataset.packageFlows) {
            const item = primaryPackages(this.packages).find(item => item.id === target.dataset.packageFlows && item.version === target.dataset.packageVersion);
            if (item) void this.installPackageFlows(item);
        }
        if (target.dataset.action === 'removeSourceConnection') void this.run('tool.connection.remove', async () => {
            await this.controls.toolPackages?.connections?.remove(target.dataset.id!); await this.readState();
        });
    }

    private async refresh(): Promise<void> {
        await this.run('tool.packages.check', () => this.readState());
    }
    private async switchPackageVersion(active: ToolPackageInfo, selected: ToolPackageInfo): Promise<void> {
        await this.run('tool.package.version.switch', async operationId => {
            const port = this.controls.toolPackages;
            if (!port?.switchVersion) throw new Error(t('toolbox.packages.switchUnavailable'));
            try {await port.switchVersion(active.id, selected.version, active.version, operationId);}
            finally {await this.readState();}
            if (!this.disposed) await this.changed();
        });
    }

    private async installPackageFlows(item: ToolPackageInfo): Promise<void> {
        const key = packageFlowKey(item), started = performance.now(); this.installingFlows = key; this.addedFlows.delete(key);
        await this.run('tool.resources.install', async operationId => {
            try {
                const port = this.controls.toolPackages;
                if (!port?.installFlows) throw new Error(t('toolbox.packages.flowsUnavailable'));
                const added = await port.installFlows(item.id, item.version);
                if (!Number.isSafeInteger(added) || added < 0) throw new Error(t('toolbox.packages.flowsInvalidResult'));
                this.addedFlows.set(key, added);
                log.info('tool.resources.installed', {operationId, packageId: item.id, version: item.version, stage: 'result', result: 'success', count: added, durationMs: Math.round(performance.now() - started)});
            } finally {this.installingFlows = undefined; await this.readState();}
            if (!this.disposed) await this.changed();
        });
    }

    private async readState(): Promise<void> {
        const results = await Promise.allSettled([this.controls.toolPackages?.list() ?? [],
            this.controls.toolPackages?.connections?.snapshot() ?? {types: [], connections: []}]);
        if (this.disposed) return;
        const [packages, connections] = results;
        if (packages.status === 'fulfilled') this.packages = packages.value;
        if (connections.status === 'fulfilled') this.connectionState = connections.value;
        this.error = [this.error, ...results.flatMap(result => result.status === 'rejected' ? [reason(result.reason)] : [])].filter(Boolean).join('；');
    }

    private async savePackage(form: HTMLFormElement): Promise<void> {
        const item = primaryPackages(this.packages).find(item => item.id === form.dataset.packageId && item.version === form.dataset.packageVersion);
        if (!item?.configuration) return;
        try {
            const settings = readPackageSettings(form, item);
            await this.run('tool.packages.configure', async () => {
                await this.controls.toolPackages!.configure!(item.id, item.version, settings);
                await this.readState(); if (!this.disposed) await this.changed();
            });
        } catch (error) {this.error = reason(error); this.body.querySelector('[role=alert]')!.textContent = this.error;}
    }
    private async saveConnection(form: HTMLFormElement): Promise<void> {
        if (this.busy || this.disposed || !validateConnectionForm(form)) return;
        const input = connectionInput(form), formId = form.dataset.id!; let saved = false;
        this.connectionNotices.set(input.id, {type: input.type, formId, state: 'saving', message: t('toolbox.connections.savingConnection')});
        await this.run('tool.connection.save', async () => {
            const port = this.controls.toolPackages?.connections;
            try {if (!port) throw new Error(t('toolbox.connections.saveUnavailable')); await port.save(input); saved = true;}
            catch (error) {this.connectionNotices.set(input.id, {type: input.type, formId, state: 'error', message: t('toolbox.connections.saveFailed') + reason(error)}); throw error;}
            await this.readState(); if (this.disposed) return;
            this.connectionToReveal = input.id;
            this.connectionNotices.set(input.id, {type: input.type, formId, state: 'saved', message: t('toolbox.connections.connectionSaved')});
            this.render(); await this.verifyConnection(input.id, input.type, formId);
            if (!this.disposed) await this.changed();
        });
        if (!saved && this.error && !this.disposed) {
            const restored = [...this.body.querySelectorAll<HTMLFormElement>('[data-form=sourceConnection]')].find(item => item.dataset.id === form.dataset.id && item.dataset.type === input.type);
            for (const control of restored?.querySelectorAll<HTMLInputElement>('input:not([type=file])') ?? []) {
                const values = {id: input.id, name: input.name, ...input.values};
                if (Object.hasOwn(values, control.name)) control.value = values[control.name as keyof typeof values];
            }
        }
    }
    private async verifyConnection(id: string, type: string, formId: string): Promise<void> {
        if (this.disposed) return;
        const port = this.controls.toolPackages?.connections, saved = this.connectionNotices.get(id)?.state === 'saved';
        const prefix = saved ? t('toolbox.connections.connectionSaved') + ' ' : '';
        if (!port?.verify) {
            this.connectionNotices.set(id, {type, formId, state: 'saved', message: prefix + t('toolbox.connections.verificationUnsupported')}); return;
        }
        this.connectionNotices.set(id, {type, formId, state: 'verifying', message: prefix + t('toolbox.connections.verifyingConnection')}); this.render();
        try {
            const result = await port.verify(id);
            if (result.status === 'failed') this.outcome = 'partial';
            this.connectionNotices.set(id, {type, formId, state: result.status === 'failed' ? 'error' : 'saved', message: prefix + verificationMessage(result)});
        } catch (error) {
            this.outcome = 'partial';
            const code = (error as {code?: string})?.code;
            const result = {status: 'failed' as const, checkedAt: Date.now(), code: code && /^TOOL_(AUTH|CONNECTION)_[A-Z_]+$/.test(code) ? code : 'TOOL_CONNECTION_VERIFICATION_FAILED'};
            this.connectionNotices.set(id, {type, formId, state: 'error', message: prefix + verificationMessage(result)});
        } finally {await this.readState();}
    }
    private async saveApplication(form: HTMLFormElement): Promise<void> {
        if (!form.reportValidity()) return;
        const data = new FormData(form), input = {type: form.dataset.type!, clientId: String(data.get('clientId') ?? ''),
            clientSecret: String(data.get('clientSecret') ?? ''), redirectUri: String(data.get('redirectUri') ?? '')};
        await this.run('tool.application.save', async () => {
            const port = this.controls.toolPackages?.connections;
            if (!port?.saveApplication) throw new Error('TOOL_AUTH_APPLICATION_UNAVAILABLE');
            await port.saveApplication(input); await this.readState();
        });
        if (this.error && !this.disposed) {
            const restored = [...this.body.querySelectorAll<HTMLFormElement>('[data-form=oauthApplication]')].find(item => item.dataset.type === input.type);
            for (const name of ['clientId', 'clientSecret', 'redirectUri'] as const) {const field = restored?.querySelector<HTMLInputElement>(`[name=${name}]`); if (field) field.value = input[name];}
        }
    }
    private async authorize(form: HTMLFormElement): Promise<void> {
        if (!validateConnectionForm(form)) return;
        const input = connectionInput(form), groups = [...form.querySelectorAll<HTMLInputElement>('[data-auth-group]:checked')].map(field => field.value);
        if (!groups.length) {this.body.querySelector('[role=alert]')!.textContent = t('toolbox.connections.choosePermissions'); return;}
        if (form.querySelector<HTMLInputElement>('[name=id]')?.type === 'hidden') this.connectionDrafts.set(input.type, input.id);
        const popup = authorizationWindow(); let navigated = false;
        await this.run('tool.authorization.begin', async operationId => {
            const port = this.controls.toolPackages?.connections;
            if (!port?.beginAuthorization) throw new Error('TOOL_AUTH_UNSUPPORTED');
            try {
                await port.save(input); const operation = await port.beginAuthorization(input.id, groups, operationId);
                if (popup && !popup.closed && operation.url && !this.disposed) {
                    if (new URL(operation.url).protocol !== 'https:') throw new Error('TOOL_AUTH_URL_INVALID');
                    popup.location.replace(operation.url); navigated = true;
                }
            } finally {await this.readState();}
        });
        if (popup && !navigated) popup.close();
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
            this.error = result.tools.filter(tool => tool.status !== 'ready').map(tool => `${tool.id}: ${(['TOOL_DISABLED', 'TOOL_PACKAGE_TOOL_DISABLED'].includes(tool.code ?? '') ? t('toolbox.packages.toolDisabled') : tool.reason || t('flow.dependencies.missingTools'))}`).join('；');
            await this.readState(); if (!this.disposed) await this.changed();
        });
    }

    private async run(operation: string, execute: (operationId: string) => Promise<void>): Promise<void> {
        if (this.busy || this.disposed) return;
        if (!['tool.connection.save', 'tool.connection.verify'].includes(operation)) this.connectionNotices.clear();
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
        const methods = new Map([...this.body.querySelectorAll<HTMLSelectElement>('[data-connection-method]')].map(select => [select.closest<HTMLElement>('[data-connection-type]')!.dataset.connectionType, select.value]));
        const expanded = new Set([...this.body.querySelectorAll<HTMLDetailsElement>('[data-package-guide][open], [data-package-preferences][open]')].map(node => node.hasAttribute('data-package-guide') ? 'guide:' + node.dataset.packageGuide : 'preferences:' + node.dataset.packagePreferences));
        const connectionDetails = new Map([...this.body.querySelectorAll<HTMLDetailsElement>('[data-connection-details]')].map(node => [node.dataset.connectionDetails, node.open]));
        this.body.innerHTML = `<p>${escapeHTML(label('help'))}</p><div class="tool-packages-dialog__actions">
            <button type="button" data-packages-refresh ${this.busy ? 'disabled' : ''}>${escapeHTML(t('action.refresh'))}</button>
            <span role="status">${this.busy ? escapeHTML(label('loading')) : ''}</span></div>
            <p role="status" data-package-version-notice></p><p class="tool-packages-dialog__error" role="alert">${escapeHTML(this.error)}</p>
            <section class="tool-packages-dialog__section">${this.packages.length ? primaryPackages(this.packages).map(item => packageRow(item, this.busy, this.connectionState, this.histories.get(item.id), this.packages.filter(version => version.id === item.id), packageFlows(item, this.busy, this.installingFlows === packageFlowKey(item), this.addedFlows.get(packageFlowKey(item))))).join('') : `<p>${escapeHTML(label('empty'))}</p>`}</section>
            ${this.controls.toolPackages?.connections && this.connectionState.types.some(type => !this.packages.some(item => packageConnectionTypes(item).includes(type.id))) ? sourceConnectionSettings({...this.connectionState, types: this.connectionState.types.filter(type => !this.packages.some(item => packageConnectionTypes(item).includes(type.id)))}, true) : ''}`;
        for (const node of this.body.querySelectorAll<HTMLDetailsElement>('[data-package-guide], [data-package-preferences]')) node.open = expanded.has(node.hasAttribute('data-package-guide') ? 'guide:' + node.dataset.packageGuide : 'preferences:' + node.dataset.packagePreferences);
        for (const node of this.body.querySelectorAll<HTMLDetailsElement>('[data-connection-details]')) if (connectionDetails.has(node.dataset.connectionDetails)) node.open = connectionDetails.get(node.dataset.connectionDetails)!;
        for (const [type, id] of this.connectionDrafts) {
            if (this.connectionState.connections.some(item => item.id === id)) {this.connectionDrafts.delete(type); continue;}
            const form = [...this.body.querySelectorAll<HTMLFormElement>('[data-form=sourceConnection]')].find(item => item.dataset.type === type && item.querySelector<HTMLInputElement>('[name=id]')?.type === 'hidden');
            const field = form?.querySelector<HTMLInputElement>('[name=id]'); if (field) field.value = id;
        }
        for (const select of this.body.querySelectorAll<HTMLSelectElement>('[data-connection-method]')) {
            const section = select.closest<HTMLElement>('[data-connection-type]')!, value = methods.get(section.dataset.connectionType);
            if (value && [...select.options].some(option => option.value === value)) {select.value = value; for (const panel of section.querySelectorAll<HTMLElement>('[data-method-panel]')) panel.hidden = panel.dataset.methodPanel !== value;}
        }
        this.body.scrollTop = scroll;
        connectionFeedback(this.body, this.connectionNotices, this.busy, !!this.controls.toolPackages?.connections?.verify);
        if (this.connectionToReveal && revealConnection(this.body, this.connectionToReveal)) this.connectionToReveal = undefined;
        this.pollAuthorizations();
    }
}

function packageRow(item: ToolPackageInfo, busy: boolean, snapshot: SourceConnections, history?: ToolRunRecord[], versions: ToolPackageInfo[] = [], flows = ''): string {
    const action = (item.status === 'available' || item.status === 'failed' ? `<button type="button" data-package-ensure="${escapeHTML(item.id)}" ${busy ? 'disabled' : ''}>${escapeHTML(label(item.status === 'failed' ? 'retry' : 'register'))}</button>` : '') + flows;
    return `<article class="tool-packages-dialog__item" data-package-id="${escapeHTML(item.id)}"><div class="tool-packages-dialog__item-header">
        <strong>${escapeHTML(item.name || item.id)}</strong><span>${item.status === 'registered' ? escapeHTML(label('activeVersion')) + ' ' : ''}${escapeHTML(item.version)}</span><span data-package-status>${escapeHTML(label(item.status))}</span></div>
        ${item.description ? `<p>${escapeHTML(item.description)}</p>` : ''}
        ${versionAction(item, versions, busy)}

        ${item.reason || item.status === 'missing' ? `<p>${escapeHTML(item.reason || label('missingHint'))}</p>` : ''}${action}${item.configuration ? `<button type="button" data-package-toggle="${escapeHTML(item.id)}" aria-pressed="${item.configuration.enabled}">${escapeHTML(label(item.configuration.enabled ? 'disable' : 'enable'))}</button>` : ''}
        <details data-connection-details="package:${escapeHTML(item.id)}"><summary>${escapeHTML(label(packageConnectionTypes(item).length ? 'settingsAndAccounts' : 'settings'))}</summary>
        ${item.configurationWarning ? `<p role="status">${escapeHTML(label('settingsNeedReview'))} (${escapeHTML(item.configurationWarning)})</p>` : ''}${packageConfiguration(item, busy)}${packageConnections(item, snapshot)}
        </details><details data-connection-details="history:${escapeHTML(item.id)}"><summary>${escapeHTML(t('toolbox.packages.history'))}</summary>
        <button type="button" data-package-history="${escapeHTML(item.id)}">${escapeHTML(t('action.refresh'))}</button>${historyView(history)}</details>
        <details><summary>${escapeHTML(t('toolbox.packages.information'))}</summary><p><code>${escapeHTML(item.tools.map(tool => tool.id).join(', '))}</code></p>${packageGuide(item)}${packageVersions(item, versions, busy)}
        ${item.canUninstall ? `<button type="button" data-package-uninstall="${escapeHTML(item.id)}" data-package-version="${escapeHTML(item.version)}">${escapeHTML(t('toolbox.packages.uninstall'))}</button>` : ''}</details></article>`;
}

function reason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const packageKeys: Record<string, string> = {TOOL_PACKAGE_SWITCH_DENIED: 'switchDenied', TOOL_PACKAGE_SWITCH_UNAVAILABLE: 'switchTargetUnavailable', TOOL_PACKAGE_SWITCH_INCOMPATIBLE: 'switchIncompatible', TOOL_PACKAGE_VERSION_CONFLICT: 'switchConflict'};
    const code = (error as {code?: unknown})?.code;
    const packageCode = typeof code === 'string' && Object.hasOwn(packageKeys, code) ? code : message;
    if (Object.hasOwn(packageKeys, packageCode)) return label(packageKeys[packageCode]) + ` (${packageCode})`;
    const keys: Record<string, string> = {TOOL_AUTH_REDIRECT_INVALID: 'invalidCallback', TOOL_AUTH_CLIENT_REQUIRED: 'clientRequired',
        TOOL_AUTH_APPLICATION_ADMIN_REQUIRED: 'adminRequired', TOOL_AUTH_APPLICATION_UNCONFIGURED: 'applicationMissing',
        TOOL_AUTH_REAUTHORIZE_REQUIRED: 'reauthorize', TOOL_AUTH_APPLICATION_STORAGE_NOT_PRIVATE: 'storagePrivate',
        TOOL_AUTH_APPLICATION_STORAGE_DENIED: 'storageDenied', TOOL_AUTH_APPLICATION_BUSY: 'applicationBusy'};
    return Object.hasOwn(keys, message) ? t(`toolbox.connections.${keys[message]}` as LocaleKey) + ` (${message})` : message;
}
function authorizationWindow(): Window | null {
    try {const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; return popup;}
    catch {return null;}
}

function primaryPackages(items: ToolPackageInfo[]): ToolPackageInfo[] {
    const groups = new Map<string, ToolPackageInfo[]>();
    for (const item of items) groups.set(item.id, [...groups.get(item.id) ?? [], item]);
    return [...groups.values()].map(group => {
        const sorted = [...group].sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true}));
        const active = group.find(item => item.status === 'registered') ?? sorted[0];
        return {...active, connectionTypes: [...new Set(group.flatMap(packageConnectionTypes))],
            connectionMethods: active.connectionMethods ?? sorted.find(item => item.connectionMethods)?.connectionMethods,
            guide: active.guide ?? sorted.find(item => item.guide)?.guide};
    });
}
function packageConnectionTypes(item: ToolPackageInfo): string[] {return [...new Set([...item.connectionTypes ?? [], ...Object.keys(item.connectionMethods ?? {}), ...item.guide?.connectionTypes ?? []])];}
function packageConnections(item: ToolPackageInfo, snapshot: SourceConnections): string {
    const types = snapshot.types.filter(type => packageConnectionTypes(item).includes(type.id));
    if (!packageConnectionTypes(item).length) return '';
    if (!types.length) return `<p>${escapeHTML(label('connectionDefinitionMissing'))}</p>`;
    const missingOAuth = types.some(type => item.connectionMethods?.[type.id]?.includes('browser') && !type.authorization);
    return `${missingOAuth ? `<p>${escapeHTML(label('connectionVersionHelp'))}</p>` : ''}${sourceConnectionSettings({...snapshot, types}, true, item.guide ? [item.guide] : [], item.connectionMethods)}`;
}
function historyView(rows?: ToolRunRecord[]): string {
    if (!rows?.length) return `<p>${escapeHTML(t('toolbox.packages.noHistory'))}</p>`;
    return `<ul>${rows.map(row => `<li>${escapeHTML(new Date(row.startedAt).toLocaleString())} · ${escapeHTML(row.toolId)} · ${escapeHTML(t(('toolbox.packages.run.' + row.status) as LocaleKey))} · ${row.durationMs ?? '—'} ms${collectionHistorySummary(row)}${row.code ? ' · ' + escapeHTML(row.code) : ''}</li>`).join('')}</ul>`;
}

function collectionHistorySummary(row: ToolRunRecord): string {
    if (row.status !== 'succeeded' || !row.collection) return '';
    const summary = row.collection;
    const count = summary.batchCount === undefined ? '' : ' · ' + t('toolbox.packages.run.batchCount', {count: summary.batchCount});
    return escapeHTML(count + ' · ' + t('toolbox.packages.run.processed', {count: summary.processed})
        + (summary.complete ? '' : ' · ' + t('toolbox.packages.run.pending')));
}
