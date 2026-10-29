// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {FlowInstallationReport, FlowInstallations, ToolPackageInfo, ToolPackages, ToolConnectionType, ToolAuthorizationView} from '@itookit/app-contracts/services';
import {showToolPackages} from '../src/toolbox/ToolPackagesDialog';

const opened: Promise<void>[] = [];
afterEach(async () => {
    document.querySelectorAll<HTMLDialogElement>('.tool-packages-dialog').forEach(dialog => dialog.close());
    await Promise.all(opened.splice(0)); document.body.replaceChildren(); vi.restoreAllMocks();
});

function setup(controls: {toolPackages?: ToolPackages; flowInstallations?: FlowInstallations}, signal?: AbortSignal) {
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const changed = vi.fn(async () => {}); opened.push(showToolPackages(controls, signal, changed));
    const dialog = document.querySelector<HTMLDialogElement>('.tool-packages-dialog')!;
    return {dialog, changed};
}

const available: ToolPackageInfo = {id: 'external-package', name: '<img src=x>', version: '1.2.0', status: 'available', tools: [{id: 'document.inspect', version: '2'}]};
it('uses declared permission groups and host callbacks, polls completion and stops polling when closed', async () => {
    const type: ToolConnectionType = {id: 'external', name: 'External', description: '', fields: [{name: 'client', label: 'Client', required: true}],
        authorization: {kind: 'oauth2', authorizationEndpoint: 'https://auth.fixture.invalid', tokenEndpoint: 'https://auth.fixture.invalid/token',
            clientIdField: 'client', refreshTokenField: 'refresh', permissionGroups: [{id: 'mail', label: 'Mail', scopes: ['read:mail']}, {id: 'events', label: 'Events', scopes: ['read:events']}]}};
    let operation: ToolAuthorizationView | undefined;
    const beginAuthorization = vi.fn(async (_id, _groups, operationId) => operation = {operationId, connectionId: 'personal', status: 'pending', expiresAt: Date.now() + 60000, url: 'https://auth.fixture.invalid/authorize'} as ToolAuthorizationView);
    const authorizationStatus = vi.fn(async () => operation = {...operation!, status: 'authorized'});
    const save = vi.fn(async () => {});
    const f = setup({toolPackages: {list: async () => [], ensure: vi.fn(), connections: {save, remove: vi.fn(), beginAuthorization, authorizationStatus,
        snapshot: async () => ({types: [type], connections: [{id: 'personal', type: 'external', name: 'Personal', values: {client: 'client'}, configuredSecrets: [],
            authorization: {scopes: [], connected: operation?.status === 'authorized', operation}}], authorizationRedirectUri: 'https://app.fixture.invalid/api/tool-connections/callback'})}}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-auth-begin]')).not.toBeNull());
    f.dialog.querySelector<HTMLInputElement>('[data-auth-group][value=events]')!.checked = false;
    f.dialog.querySelector<HTMLButtonElement>('[data-auth-begin]')!.click();
    await vi.waitFor(() => expect(beginAuthorization).toHaveBeenCalledWith('personal', ['mail'], expect.any(String)));
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(beginAuthorization.mock.invocationCallOrder[0]);
    await vi.waitFor(() => expect(f.dialog.querySelector('a[href="https://auth.fixture.invalid/authorize"]')).not.toBeNull());
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-authorization-status]')!.textContent).toContain('授权成功'), {timeout: 2500});
    expect(f.dialog.querySelector('[data-auth-revoke]')).not.toBeNull();
    f.dialog.close(); const count = authorizationStatus.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 1100)); expect(authorizationStatus).toHaveBeenCalledTimes(count);
});
it('installs package-owned workflows through a trusted identity and configures user connections in the tool panel', async () => {
    const installFlows = vi.fn(async () => 1), save = vi.fn(async () => {});
    const f = setup({toolPackages: {list: async () => [{...available, status: 'registered', flowCount: 1}], ensure: vi.fn(), installFlows,
        connections: {snapshot: async () => ({types: [{id: 'external', name: 'External service', description: '', fields: [{name: 'key', label: 'Key', secret: true, required: true}]}], connections: []}), save, remove: vi.fn()}}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-flows]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.click();
    await vi.waitFor(() => expect(installFlows).toHaveBeenCalledWith(available.id, available.version));
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.disabled).toBe(false));
    const form = f.dialog.querySelector<HTMLFormElement>('[data-form=sourceConnection]')!;
    form.querySelector<HTMLInputElement>('[name=id]')!.value = 'personal'; form.querySelector<HTMLInputElement>('[name=name]')!.value = 'My service';
    form.querySelector<HTMLInputElement>('[name=key]')!.value = 'private-key';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({id: 'personal', type: 'external', name: 'My service', values: {key: 'private-key'}}));
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLInputElement>('[name=key]')!.value).toBe(''));
});

it('registers only catalog tool identities, reports the actual result and ignores duplicate clicks', async () => {
    let release!: (value: {tools: Array<{id: string; status: 'ready'}>}) => void;
    const ensure = vi.fn(() => new Promise<{tools: Array<{id: string; status: 'ready'}>}>(resolve => {release = resolve;}));
    let registered = false;
    const list = vi.fn(async () => [{...available, status: registered ? 'registered' as const : 'available' as const}]);
    const f = setup({toolPackages: {list, ensure}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull());
    expect(f.dialog.querySelector('img')).toBeNull(); expect(f.dialog.querySelector('input')).toBeNull();
    const button = f.dialog.querySelector<HTMLButtonElement>('[data-package-ensure]')!; button.click(); button.click();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce()); expect(ensure).toHaveBeenCalledWith(available.tools);
    registered = true; release({tools: [{id: 'document.inspect', status: 'ready'}]});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册'));
    expect(f.changed).toHaveBeenCalledOnce(); expect(f.dialog.querySelector('[data-package-ensure]')).toBeNull();
});

it('shows a missing package reason without advertising an arbitrary installation source', async () => {
    const ensure = vi.fn(), list = vi.fn(async () => [{...available, status: 'missing' as const, reason: 'Package is not installed on this host'}]);
    const f = setup({toolPackages: {list, ensure}});
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('Package is not installed on this host'));
    expect(f.dialog.querySelector('[data-package-ensure]')).toBeNull(); expect(f.dialog.querySelector('input')).toBeNull();
    f.dialog.querySelector<HTMLButtonElement>('[data-packages-refresh]')!.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2)); expect(ensure).not.toHaveBeenCalled();
});

it('keeps missing tools and configuration requirements distinct while retrying Flow dependencies', async () => {
    const report: FlowInstallationReport = {flowId: 'external-flow', name: 'Document workflow', status: 'missingTools', tools: [{id: 'document.inspect', status: 'missing'}], parameters: [], connections: [], errors: []};
    const configured: FlowInstallationReport = {...report, status: 'needsConfiguration', tools: [{id: 'document.inspect', status: 'ready'}], connections: [{code: 'MISSING_CONNECTION', field: 'vision', message: 'Choose an image-capable connection'}]};
    let current = report;
    const ensure = vi.fn(async () => {current = configured; return current;}), check = vi.fn(async () => current);
    const f = setup({flowInstallations: {list: async () => [current], ensure, check}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-flow-check]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-flow-check]')!.click();
    await vi.waitFor(() => expect(check).toHaveBeenCalledWith('external-flow')); expect(ensure).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLButtonElement>('[data-flow-ensure]')!.disabled).toBe(false));
    f.dialog.querySelector<HTMLButtonElement>('[data-flow-ensure]')!.click();
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('Choose an image-capable connection'));
    expect(f.dialog.textContent).toContain('需要配置'); expect(f.dialog.textContent).not.toContain('依赖已就绪');
    expect(ensure).toHaveBeenCalledWith('external-flow');
});

it('does not resurrect a closed package dialog after a late registration response', async () => {
    let release!: (value: {tools: Array<{id: string; status: 'ready'}>}) => void;
    const ensure = vi.fn(() => new Promise<{tools: Array<{id: string; status: 'ready'}>}>(resolve => {release = resolve;}));
    const controller = new AbortController(), f = setup({toolPackages: {list: async () => [available], ensure}}, controller.signal);
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-ensure]')!.click();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce()); controller.abort(); release({tools: [{id: 'document.inspect', status: 'ready'}]});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('.tool-packages-dialog')).toBeNull(); expect(f.changed).not.toHaveBeenCalled();
});

it.each(['package', 'flow'])('refreshes both package and Flow states after preparing the %s', async target => {
    let registered = false;
    const report = (): FlowInstallationReport => ({flowId: 'external-flow', name: 'Document workflow', status: registered ? 'ready' : 'missingTools',
        tools: [{id: 'document.inspect', status: registered ? 'ready' : 'missing'}], parameters: [], connections: [], errors: []});
    const listPackages = vi.fn(async () => [{...available, status: registered ? 'registered' as const : 'available' as const}]);
    const listFlows = vi.fn(async () => [report()]);
    const f = setup({toolPackages: {list: listPackages, ensure: async () => {registered = true; return {tools: report().tools};}},
        flowInstallations: {list: listFlows, check: async () => report(), ensure: async () => {registered = true; return report();}}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-flow-ensure]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>(target === 'package' ? '[data-package-ensure]' : '[data-flow-ensure]')!.click();
    await vi.waitFor(() => {
        expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册');
        expect(f.dialog.querySelector('[data-flow-id]')!.textContent).toContain('依赖已就绪');
    });
    expect(listPackages).toHaveBeenCalledTimes(2); expect(listFlows).toHaveBeenCalledTimes(2);
    expect(f.dialog.querySelector('[data-package-ensure]')).toBeNull(); expect(f.dialog.querySelector('[data-flow-ensure]')).toBeNull();
});
