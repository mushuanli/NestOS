// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import type {ApplicationDiagnostics, DiagnosticEvent, ProjectRemoteMountPort} from '@itookit/app-contracts/services';
import {DiagnosticLogView} from '../../app-settings/src/editors/log/DiagnosticLogView';
import {showDiagnostics} from '../src/diagnostics/dialog';
import {mcpStatusIcon} from '../src/toolbox/mcp-status';
import {renderProjectAccess} from '../src/diagnostics/project-access';

const controllers: AbortController[] = [];
beforeEach(() => {for (const method of ['showModal', 'close']) Object.defineProperty(HTMLDialogElement.prototype, method, {configurable: true, value: vi.fn()});});
afterEach(() => {for (const controller of controllers.splice(0)) controller.abort(); document.body.replaceChildren(); vi.restoreAllMocks();});
const event: DiagnosticEvent = {id: 'event-1', operationId: 'operation-1', timestamp: 1, module: 'cells', operation: 'project.connection',
    projectId: 'project-a', connectionId: 'office', stage: 'root-probe', result: 'failure', level: 'error', code: 'EACCES', reason: 'authorization-changed'};
function diagnostics(events = [event]) {
    let changed: (() => void) | undefined;
    const stop = vi.fn();
    const port = {query: vi.fn(async () => ({events, retained: events.length, limit: 200, truncated: false, persistence: 'ready' as const})),
        onChange: vi.fn(listener => {changed = listener; return stop;})} satisfies ApplicationDiagnostics;
    return {port, changed: () => changed?.(), stop};
}
function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label);
    if (!button) throw new Error(label); button.click();
}
it('shows repetition counts and time bounds while keeping expanded details open on refresh', async () => {
    const grouped: DiagnosticEvent = {...event, series: {count: 4, firstAt: 1, lastAt: 1, firstOperationId: event.operationId, samples: []}};
    const d = diagnostics([grouped]), root = document.createElement('div'), view = new DiagnosticLogView(root, d.port);
    await view.init(); expect(root.textContent).toContain(t('diagnostics.occurrences', {count: 4}));
    expect(root.textContent).toContain(t('diagnostics.firstAt')); expect(root.textContent).toContain(t('diagnostics.lastAt'));
    root.querySelector('details')!.open = true; grouped.series!.count = 8; await view.refresh();
    expect(root.querySelector('details')!.open).toBe(true); expect(root.textContent).toContain(t('diagnostics.occurrences', {count: 8})); view.destroy();
});
it('explains accepted identity with denied export and provides exact, editable server repair guidance', async () => {
    const configure = vi.fn(async () => {}), remount = vi.fn(async () => {});
    const root = renderProjectAccess({mountId: 'mount', status: 'offline', connectionId: 'node', connectionName: '<script>MCP</script>',
        alias: 'docs', principalId: 'owner', access: 'rw', boundAuthorizationRevision: 'old', authorizationRevision: 'current', authorizationChanged: true,
        protocol: {status: 'connected', issues: []}, authorization: {checkedAt: 1, authentication: 'accepted', exportAccess: 'none', projectAccess: 'denied', reason: 'export-not-granted'}},
        {configureConnection: configure, remount}, () => false);
    document.body.append(root);
    expect(root.querySelector('script')).toBeNull(); expect(root.textContent).toContain(t('diagnostics.access.authAccepted'));
    expect(root.textContent).toContain(t('diagnostics.access.reason.export-not-granted'));
    const command = root.querySelector('pre')!; expect(command.textContent).toBe('cells access --config /path/to/config.toml grant owner docs rw');
    const mode = root.querySelector('select')!; mode.value = 'ro'; mode.dispatchEvent(new Event('change'));
    expect(command.textContent).toContain('grant owner docs ro'); expect(command.textContent).not.toContain('--execute');
    click(t('remote.remountAs')); await vi.waitFor(() => expect(remount).toHaveBeenCalledOnce());
    click(t('diagnostics.access.configureMCP')); await vi.waitFor(() => expect(configure).toHaveBeenCalledWith('node'));
});
it('opens project status immediately, reads backend events and preserves diagnostics when the project is offline', async () => {
    const d = diagnostics(), controller = new AbortController(); controllers.push(controller);
    const remote = {onChange: vi.fn(() => vi.fn()), projectStatus: vi.fn(async () => ({projectId: 'project-a', status: 'offline', checkedAt: 1,
        mounts: [{mountId: 'mount', status: 'offline', failure: event}]})), checkConnections: vi.fn(async () => {})} as unknown as ProjectRemoteMountPort;
    const pending = showDiagnostics({title: 'Project status', projectId: 'project-a', diagnostics: d.port, remote, signal: controller.signal});
    expect(document.querySelector('dialog')).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain('EACCES'));
    expect(document.querySelector('[data-status="offline"]')?.textContent).toContain(t('remote.state.offline'));
    expect(d.port.query).toHaveBeenCalledWith(expect.objectContaining({projectId: 'project-a'}));
    click(t('diagnostics.check')); await vi.waitFor(() => expect(remote.checkConnections).toHaveBeenCalledWith('project-a', {timeoutMs: 3000}));
    click(t('action.close')); await pending; expect(d.stop).toHaveBeenCalledOnce();
});
it('keeps log query errors visible and supports retry instead of reporting an empty log', async () => {
    const d = diagnostics(), root = document.createElement('div'); document.body.append(root);
    d.port.query.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'}));
    const view = new DiagnosticLogView(root, d.port); await view.init();
    expect(root.textContent).toContain(t('diagnostics.readFailed', {code: 'EIO'})); expect(root.textContent).not.toContain('PRIVATE_BODY');
    await view.refresh(); expect(root.textContent).toContain('EACCES');
    const search = root.querySelector('input')!; search.value = 'operation-1'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(d.port.query).toHaveBeenCalledWith(expect.objectContaining({search: 'operation-1'})));
    view.destroy(); expect(d.stop).toHaveBeenCalledOnce();
});
it('escapes event metadata and ignores a delayed response after the view closes', async () => {
    const d = diagnostics([{...event, stage: '<img src=x onerror=alert(1)>'}]);
    const root = document.createElement('div'), view = new DiagnosticLogView(root, d.port); await view.init();
    expect(root.querySelector('img')).toBeNull(); expect(root.textContent).toContain('<img');
    let finish!: (value: Awaited<ReturnType<ApplicationDiagnostics['query']>>) => void;
    d.port.query.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const pending = view.refresh(); view.destroy(); finish({events: [event], retained: 1, limit: 200, truncated: false, persistence: 'ready'}); await pending;
    expect(root.children).toHaveLength(0);
});
it('does not show a healthy MCP badge when linked projects fail or remain unchecked', () => {
    const connected = {mcpConnectionState: {status: 'connected', checkedAt: 1, issues: []}};
    const healthy = mcpStatusIcon(connected);
    const failed = mcpStatusIcon({...connected, mcpProjectHealth: {total: 1, offline: 1, unknown: 0}});
    const unchecked = mcpStatusIcon({...connected, mcpProjectHealth: {total: 1, offline: 0, unknown: 1}});
    expect(failed).toContain(t('mcp.state.connected')); expect(failed).toContain(t('diagnostics.mcpProjects', {total: 1, offline: 1, unknown: 0}));
    expect(failed).not.toBe(healthy); expect(unchecked).not.toBe(healthy);
});


it('offers a binding refresh independently of checking and keeps authorization errors in the status window', async () => {
    const d = diagnostics(), controller = new AbortController(); controllers.push(controller);
    const refreshBinding = vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EACCES'})).mockResolvedValue(undefined);
    const pending = showDiagnostics({title: 'Project status', projectId: 'project-a', diagnostics: d.port, refreshBinding, signal: controller.signal});
    click(t('diagnostics.refreshBinding'));
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain(t('diagnostics.bindingRefreshFailed')));
    expect(document.body.textContent).not.toContain('PRIVATE_BODY');
    click(t('diagnostics.refreshBinding'));
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain(t('diagnostics.bindingRefreshed')));
    expect(refreshBinding).toHaveBeenCalledTimes(2); controller.abort(); await pending;
});

it('keeps close and probe actions outside the scrolling long project status content', async () => {
    const d = diagnostics(), controller = new AbortController(); controllers.push(controller);
    const stop = vi.fn(), remote = {onChange: () => stop, checkConnections: vi.fn(async () => {}), projectStatus: async () => ({
        projectId: 'project-a', status: 'online', mounts: Array.from({length: 12}, (_, index) => ({mountId: String(index), status: 'online', root: '/docs/' + index}))})} as unknown as ProjectRemoteMountPort;
    const pending = showDiagnostics({title: 'Long project status', projectId: 'project-a', diagnostics: d.port, remote, signal: controller.signal});
    const dialog = document.querySelector<HTMLDialogElement>('.diagnostic-dialog')!;
    await vi.waitFor(() => expect(dialog.querySelectorAll('.diagnostic-dialog__content .diagnostic-access')).toHaveLength(12));
    const close = dialog.querySelector<HTMLButtonElement>('.diagnostic-dialog__footer button.diagnostic-dialog__close')!;
    expect(dialog.querySelector('.diagnostic-dialog__header button')).toBeNull();
    expect(close.textContent).toBe(t('action.close')); expect(close.disabled).toBe(false);
    expect(dialog.querySelector('.diagnostic-dialog__content')?.contains(close)).toBe(false);
    click(t('diagnostics.check')); await vi.waitFor(() => expect(remote.checkConnections).toHaveBeenCalledOnce());
    close.click(); await pending;
    expect(document.querySelector('.diagnostic-dialog')).toBeNull(); expect(stop).toHaveBeenCalledOnce();
    expect(d.stop).toHaveBeenCalledOnce();
});


it('preserves repair choices across status refreshes and quotes a configuration path safely', () => {
    const draft = {}, mount = {mountId: 'mount', status: 'offline' as const, alias: 'docs', principalId: 'owner', access: 'rw' as const};
    const first = renderProjectAccess(mount, {}, () => false, draft);
    const input = first.querySelector<HTMLInputElement>('input[type=text]')!;
    input.value = "/srv/a'b/config.toml"; input.dispatchEvent(new Event('input'));
    const mode = first.querySelector('select')!; mode.value = 'ro'; mode.dispatchEvent(new Event('change'));
    const execute = first.querySelector<HTMLInputElement>('input[type=checkbox]')!; execute.checked = true; execute.dispatchEvent(new Event('change'));
    const next = renderProjectAccess(mount, {}, () => false, draft);
    expect(next.querySelector('select')!.value).toBe('ro'); expect(next.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    expect(next.querySelector<HTMLInputElement>('input[type=text]')!.value).toBe("/srv/a'b/config.toml");
    expect(next.querySelector('pre')!.textContent).toContain("--config '/srv/a'\\''b/config.toml' grant owner docs ro --execute");
});

it('embeds project diagnostics without a second modal and releases subscriptions on close', async () => {
    const d = diagnostics(), controller = new AbortController(), container = document.createElement('section');
    document.body.append(container);
    const closed = showDiagnostics({container, diagnostics:d.port, title:t('diagnostics.projectStatus'), signal:controller.signal});
    await vi.waitFor(() => expect(d.port.onChange).toHaveBeenCalled());
    expect(container.querySelector('.diagnostic-dialog--embedded')).not.toBeNull();
    expect(container.querySelector('dialog')).toBeNull();
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    controller.abort(); await closed;
    expect(d.stop).toHaveBeenCalled(); expect(container.childElementCount).toBe(0);
});
