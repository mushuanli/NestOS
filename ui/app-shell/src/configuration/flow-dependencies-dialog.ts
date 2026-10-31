import {createModuleLogger, randomUUID, t} from '@itookit/common';
import type {FlowInstallations, FlowInstallationReport} from '@itookit/app-contracts/services';

const log = createModuleLogger('flow-dependencies-ui');
const codeOf = (error: unknown) => typeof (error as {code?: unknown})?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test((error as {code: string}).code)
    ? (error as {code: string}).code : 'FLOW_DEPENDENCY_REQUEST_FAILED';
const disabledTool = (tool: FlowInstallationReport['tools'][number]) => ['TOOL_DISABLED', 'TOOL_PACKAGE_TOOL_DISABLED'].includes(tool.code ?? '');

/** Check only the selected saved workflow; preparation never invokes its nodes. */
export function showFlowDependencies(port: Pick<FlowInstallations, 'check' | 'ensure'>, flowId: string, signal: AbortSignal, manageTools?: () => Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => new FlowDependenciesDialog(port, flowId, signal, resolve, manageTools).open());
}
class FlowDependenciesDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly content = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly check = document.createElement('button');
    private readonly prepare = document.createElement('button');
    private readonly manage = document.createElement('button');
    private readonly origin = document.activeElement;
    private busy = false;
    private closed = false;
    constructor(private readonly port: Pick<FlowInstallations, 'check' | 'ensure'>, private readonly id: string,
        private readonly signal: AbortSignal, private readonly done: () => void, private readonly manageTools?: () => Promise<void>) {}
    open(): void {
        this.dialog.className = 'flow-dependencies-dialog'; this.dialog.setAttribute('aria-label', t('flow.dependencies.title'));
        const title = document.createElement('h2'), hint = document.createElement('p'), footer = document.createElement('footer');
        title.textContent = t('flow.dependencies.title'); hint.textContent = t('flow.dependencies.savedHint');
        this.content.className = 'flow-dependencies-dialog__content'; this.status.setAttribute('role', 'status');
        this.check.type = this.prepare.type = 'button'; this.check.textContent = t('flow.dependencies.check'); this.prepare.textContent = t('flow.dependencies.prepare');
        this.check.onclick = () => {void this.read(false);}; this.prepare.onclick = () => {void this.read(true);}; this.prepare.hidden = true;
        this.manage.type = 'button'; this.manage.textContent = t('flow.dependencies.manage'); this.manage.hidden = true;
        this.manage.onclick = () => {void this.openTools();};
        const close = document.createElement('button'); close.type = 'button'; close.textContent = t('action.close'); close.onclick = this.close;
        close.autofocus = true; footer.append(this.check, this.prepare, this.manage, close); this.dialog.append(title, hint, this.content, this.status, footer);
        this.dialog.oncancel = event => {event.preventDefault(); this.close();};
        this.signal.addEventListener('abort', this.close, {once: true});
        document.body.append(this.dialog); this.dialog.showModal(); void this.read(false);
    }
    private async read(prepare: boolean): Promise<void> {
        if (this.busy || this.closed) return;
        const operationId = randomUUID(), started = performance.now(), operation = prepare ? 'flow.dependencies.prepare' : 'flow.dependencies.check';
        this.busy = true; this.check.disabled = this.prepare.disabled = true; this.status.textContent = t('flow.dependencies.loading');
        log.info(operation, {operationId, stage: 'request', result: 'started'});
        try {
            const report = await this.port[prepare ? 'ensure' : 'check'](this.id);
            if (report.flowId !== this.id) throw Object.assign(new Error('Flow dependency identity mismatch'), {code: 'FLOW_DEPENDENCY_IDENTITY_MISMATCH'});
            log.info(operation, {operationId, stage: 'result', result: report.status, toolCount: report.tools.length, durationMs: Math.round(performance.now() - started)});
            if (this.closed) return;
            this.render(report); this.status.textContent = t(`flow.dependencies.${report.status}`);
        } catch (error) {
            const code = codeOf(error);
            if (!this.closed) this.status.textContent = t('flow.dependencies.readFailed', {code});
            log.warn(operation, {operationId, stage: 'request', result: 'failure', code, durationMs: Math.round(performance.now() - started)});
        } finally {this.busy = false; if (!this.closed) this.check.disabled = this.prepare.disabled = false;}
    }
    private render(report: FlowInstallationReport): void {
        const title = document.createElement('h3'); title.textContent = report.name ?? report.flowId; this.content.replaceChildren(title);
        this.section(t('flow.dependencies.tools'), report.tools.map(tool => `${tool.id}${tool.version ? '@' + tool.version : ''} · ${
            tool.status === 'ready' ? t('flow.dependencies.ready') : disabledTool(tool) ? t('toolbox.packages.toolDisabled') : tool.reason || tool.code || t('flow.dependencies.missingTools')}`));
        const issues = (items: FlowInstallationReport['errors']) => items.map(issue => issue.code === 'CALLABLE_LOCAL_ONLY' ? t('flow.dependencies.localOnly')
            : `${issue.field ? issue.field + ': ' : ''}${issue.message}`);
        this.section(t('flow.dependencies.parameters'), issues(report.parameters));
        this.section(t('flow.dependencies.connections'), issues(report.connections)); this.section(t('flow.dependencies.failed'), issues(report.errors));
        const unresolved = report.tools.filter(tool => tool.status !== 'ready');
        this.prepare.hidden = !unresolved.some(tool => !disabledTool(tool));
        this.manage.hidden = !this.manageTools || !unresolved.length;
    }
    private section(label: string, items: string[]): void {
        if (!items.length) return;
        const title = document.createElement('h4'), list = document.createElement('ul'); title.textContent = label;
        for (const value of items) {const item = document.createElement('li'); item.textContent = value; list.append(item);}
        this.content.append(title, list);
    }
    private async openTools(): Promise<void> {
        if (!this.manageTools || this.manage.disabled || this.closed) return;
        const operationId = randomUUID(), started = performance.now(); this.manage.disabled = true;
        try {
            await this.manageTools();
            log.info('flow.dependencies.navigate', {operationId, stage: 'navigation', result: 'success', durationMs: Math.round(performance.now() - started)}); this.close();
        }
        catch (error) {
            const code = codeOf(error);
            if (!this.closed) this.status.textContent = t('flow.dependencies.manageFailed', {code});
            log.warn('flow.dependencies.navigate', {operationId, stage: 'navigation', result: 'failure', code, durationMs: Math.round(performance.now() - started)});
        } finally {if (!this.closed) this.manage.disabled = false;}
    }
    private close = (): void => {
        if (this.closed) return;
        this.closed = true; this.signal.removeEventListener('abort', this.close); this.dialog.close(); this.dialog.remove();
        if (this.origin instanceof HTMLElement && this.origin.isConnected) this.origin.focus(); this.done();
    };
}
