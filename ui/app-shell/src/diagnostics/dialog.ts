import {projectStatusLabel} from './presentation';
import {renderProjectAccess, type ProjectAccessActions, type ProjectAccessDraft} from './project-access';
import {t} from '@itookit/common';
import {DiagnosticLogView, diagnosticReasonText} from '@itookit/app-settings';
import type {ApplicationDiagnostics, ProjectRemoteMountPort, RemoteProjectStatus} from '@itookit/app-contracts/services';

interface Options extends ProjectAccessActions {
    container?: HTMLElement;
    diagnostics?: ApplicationDiagnostics;
    remote?: ProjectRemoteMountPort;
    projectId?: string;
    connectionId?: string;
    title: string;
    signal: AbortSignal;
    refreshBinding?(): Promise<void>;
}
export function showDiagnostics(options: Options): Promise<void> {
    if (options.signal.aborted) return Promise.resolve();
    return new Promise(resolve => new DiagnosticDialog(options, resolve).open());
}
class DiagnosticDialog {
    private readonly dialog: HTMLDialogElement | HTMLDivElement;
    private readonly summary = document.createElement('section');
    private readonly hint = document.createElement('p');
    private readonly check = document.createElement('button');
    private readonly binding = document.createElement('button');
    private readonly logsRoot = document.createElement('div');
    private readonly logs: DiagnosticLogView;
    private stop?: () => void;
    private closed = false;
    private reading?: Promise<void>;
    private dirty = false;
    private lastState: string | undefined = '@initial';
    private accessDrafts = new Map<string, ProjectAccessDraft>();
    constructor(private readonly options: Options, private readonly done: () => void) {
        this.dialog = document.createElement(options.container ? 'div' : 'dialog');
        this.logs = new DiagnosticLogView(this.logsRoot, options.diagnostics,
            {projectId: options.projectId, connectionId: options.connectionId});
    }
    open(): void {
        this.dialog.className = this.options.container ? 'diagnostic-dialog diagnostic-dialog--embedded' : 'diagnostic-dialog';
        const title = document.createElement('h2'); title.textContent = this.options.title;
        this.dialog.setAttribute('aria-label', this.options.title);
        const close = document.createElement('button'); close.type = 'button'; close.textContent = t('action.close'); close.onclick = () => this.close();
        close.className = 'diagnostic-dialog__close'; close.setAttribute('aria-label', t('action.close')); close.autofocus = true;
        const header = document.createElement('header'); header.className = 'diagnostic-dialog__header'; header.append(title);
        const content = document.createElement('div'); content.className = 'diagnostic-dialog__content'; content.append(this.summary, this.logsRoot);
        this.check.type = 'button'; this.check.textContent = t('diagnostics.check'); this.check.onclick = () => {void this.probe();};
        const actions = document.createElement('div'); actions.className = 'diagnostic-log__controls'; actions.append(this.check, this.binding, close);
        this.binding.type = 'button'; this.binding.textContent = t('diagnostics.refreshBinding'); this.binding.hidden = !this.options.refreshBinding;
        this.binding.title = t('diagnostics.refreshBindingHint'); this.binding.onclick = () => {void this.updateBinding();};
        const footer = document.createElement('footer'); footer.className = 'diagnostic-dialog__footer';
        this.hint.setAttribute('role', 'status'); footer.append(this.hint, actions); this.dialog.append(header, content, footer);
        this.check.hidden = !this.options.remote || !this.options.projectId && !this.options.connectionId;
        this.dialog.oncancel = event => {event.preventDefault(); this.close();};
        this.options.signal.addEventListener('abort', this.close, {once: true});
        if (this.options.container) {close.hidden = true; this.options.container.append(this.dialog);}
        else {document.body.append(this.dialog); (this.dialog as HTMLDialogElement).showModal();}
        this.stop = this.options.remote?.onChange(() => {void this.refresh();});
        void this.logs.init(); void this.refresh();
        if (this.options.projectId && this.options.remote?.inspectProjectAccess)
            void this.options.remote.inspectProjectAccess(this.options.projectId, {timeoutMs: 3000}).then(() => this.refresh()).catch(() => {if (!this.closed) this.hint.textContent = t('diagnostics.statusFailed');});
    }
    private refresh(): Promise<void> {
        this.dirty = true;
        return this.reading ??= this.read().finally(() => {this.reading = undefined;});
    }
    private async read(): Promise<void> {
        while (this.dirty && !this.closed) {
            this.dirty = false;
            try {
                const state = this.options.projectId && this.options.remote?.projectStatus
                    ? await this.options.remote.projectStatus(this.options.projectId) : undefined;
                if (this.closed || this.dirty) continue;
                const signature = JSON.stringify(state);
                if (signature === this.lastState) continue;
                this.lastState = signature; this.summary.replaceChildren();
                if (state) this.renderState(state);
                else this.summary.textContent = t('diagnostics.mcpExplanation');
            } catch {if (!this.closed) this.hint.textContent = t('diagnostics.statusFailed');}
        }
    }
    private renderState(state: RemoteProjectStatus): void {
        const heading = document.createElement('strong'); heading.textContent = t('diagnostics.projectState', {state: projectStatusLabel(state)});
        heading.dataset.status = state.status; this.summary.append(heading);
        const time = document.createElement('p'); time.textContent = state.checkedAt
            ? t('diagnostics.checkedAt', {time: new Date(state.checkedAt).toLocaleString()}) : t('diagnostics.neverChecked'); this.summary.append(time);
        for (const failure of state.issues ?? (state.issue ? [state.issue] : [])) {
            const issue = document.createElement('p'); issue.textContent = [failure.stage, failure.profileId, failure.code, diagnosticReasonText(failure.reason)].filter(Boolean).join(' · '); this.summary.append(issue);
        }
        for (const mount of state.mounts) {
            const key = JSON.stringify([mount.connectionId, mount.alias, mount.root]);
            if (!this.accessDrafts.has(key)) this.accessDrafts.set(key, {});
            this.summary.append(renderProjectAccess(mount, {remount: this.options.remount, configureConnection: this.options.configureConnection ? async id => {await this.options.configureConnection!(id); this.close();} : undefined}, () => this.closed, this.accessDrafts.get(key)));
            const line = document.createElement('p'); line.textContent = [mount.connectionName ?? mount.connectionId, t(`remote.state.${mount.status}`), mount.failure?.code,
                mount.failure?.reason ? diagnosticReasonText(mount.failure.reason) : ''].filter(Boolean).join(' · '); this.summary.append(line);
        }
    }
    private async updateBinding(): Promise<void> {
        if (this.binding.disabled || !this.options.refreshBinding) return;
        this.binding.disabled = this.check.disabled = true; this.hint.textContent = t('diagnostics.refreshingBinding');
        try {await this.options.refreshBinding(); if (!this.closed) this.hint.textContent = t('diagnostics.bindingRefreshed');}
        catch {if (!this.closed) this.hint.textContent = t('diagnostics.bindingRefreshFailed');}
        finally {
            if (!this.closed) {this.binding.disabled = this.check.disabled = false; await this.refresh(); await this.logs.refresh();}
        }
    }
    private async probe(): Promise<void> {
        if (this.check.disabled || !this.options.remote) return;
        this.check.disabled = true; this.hint.textContent = t('remote.state.checking');
        try {
            if (this.options.projectId) await this.options.remote.checkConnections(this.options.projectId, {timeoutMs: 3000});
            else if (this.options.connectionId) await this.options.remote.checkConnection(this.options.connectionId, {timeoutMs: 3000});
            if (!this.closed) {this.hint.textContent = ''; await this.refresh(); await this.logs.refresh();}
        } catch {if (!this.closed) {this.hint.textContent = t('diagnostics.checkFailed'); await this.logs.refresh();}}
        finally {if (!this.closed) this.check.disabled = false;}
    }
    private close = (): void => {
        if (this.closed) return;
        this.closed = true; this.stop?.(); this.logs.destroy(); this.options.signal.removeEventListener('abort', this.close);
        if (this.dialog instanceof HTMLDialogElement) this.dialog.close();
        this.dialog.remove(); this.done();
    };
}
