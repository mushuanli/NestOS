// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {FlowInstallations, ToolPackageInfo, ToolPackages, ToolConnectionType, ToolAuthorizationView} from '@itookit/app-contracts/services';
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
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.disabled).toBe(true));
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLButtonElement>('[data-packages-refresh]')!.disabled).toBe(false));
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

it('does not enumerate or prepare workflows inside the tool package dialog', async () => {
    const list = vi.fn(async () => []), check = vi.fn(), ensure = vi.fn();
    const f = setup({toolPackages: {list: async () => [available], ensure: vi.fn()}, flowInstallations: {list, check, ensure}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull());
    expect(f.dialog.querySelector('[data-flow-id], [data-flow-check], [data-flow-ensure]')).toBeNull();
    expect(list).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
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

it('refreshes package registration without querying unrelated workflow readiness', async () => {
    let registered = false;
    const listPackages = vi.fn(async () => [{...available, status: registered ? 'registered' as const : 'available' as const}]);
    const listFlows = vi.fn();
    const f = setup({toolPackages: {list: listPackages, ensure: async () => {registered = true; return {tools: [{id: 'document.inspect', status: 'ready'}]};}},
        flowInstallations: {list: listFlows, check: vi.fn(), ensure: vi.fn()}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-ensure]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册'));
    expect(listPackages).toHaveBeenCalledTimes(2); expect(listFlows).not.toHaveBeenCalled();
});

const guide: NonNullable<ToolPackageInfo['guide']> = {version: 1, title: '<img src=x>', description: 'Setup remains available after registration', steps: [
    {title: 'Register', description: '<script>private</script>', command: 'example <input> & echo done', links: [{label: 'Documentation', url: 'https://docs.example.com/setup'}]},
    {title: 'Authenticate', description: 'Configure your own account'},
]};
it('retains the full escaped guide before and after registration and preserves its expanded state on refresh', async () => {
    let registered = false;
    const f = setup({toolPackages: {list: async () => [{...available, guide, status: registered ? 'registered' : 'available'}],
        ensure: async () => {registered = true; return {tools: [{id: 'document.inspect', status: 'ready'}]};}}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-guide]')).not.toBeNull());
    f.dialog.querySelector<HTMLDetailsElement>('[data-package-guide]')!.open = true;
    expect(f.dialog.querySelector('img, script')).toBeNull();
    expect(f.dialog.querySelector('pre')!.textContent).toBe('example <input> & echo done');
    expect(f.dialog.querySelector('a')!.rel).toBe('noopener noreferrer'); expect(f.dialog.querySelector('a')!.target).toBe('_blank');
    f.dialog.querySelector<HTMLButtonElement>('[data-package-ensure]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册'));
    expect(f.dialog.querySelector<HTMLDetailsElement>('[data-package-guide]')!.open).toBe(true);
    expect(f.dialog.textContent).toContain('Authenticate'); expect(f.dialog.textContent).toContain('Register');
    f.dialog.querySelector<HTMLButtonElement>('[data-packages-refresh]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLButtonElement>('[data-packages-refresh]')!.disabled).toBe(false));
    expect(f.dialog.querySelector<HTMLDetailsElement>('[data-package-guide]')!.open).toBe(true);
});

it('reports guide errors without removing package registration controls', async () => {
    const f = setup({toolPackages: {list: async () => [{...available, guideError: 'TOOL_PACKAGE_GUIDE_INVALID'}], ensure: vi.fn()}});
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('指南暂不可用'));
    expect(f.dialog.textContent).toContain('TOOL_PACKAGE_GUIDE_INVALID'); expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull();
});

it('lets a user save enablement and ordinary defaults while keeping the guide visible and expanded', async () => {
    let configuration: NonNullable<ToolPackageInfo['configuration']> = {enabled: false, defaults: {}, tools: [{id: 'document.inspect', parameters: [{name: 'directory', type: 'string', label: 'Directory'}]}]};
    const configure = vi.fn(async (_id, _version, settings) => {configuration = {...configuration, ...settings};});
    const f = setup({toolPackages: {list: async () => [{...available, status: 'registered', guide, configuration}], ensure: vi.fn(), configure}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-form=toolPackage]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-form=toolPackage]')!;
    f.dialog.querySelector<HTMLDetailsElement>('[data-package-guide]')!.open = true;
    form.querySelector<HTMLDetailsElement>('details')!.open = true;
    form.querySelector<HTMLInputElement>('[name=enabled]')!.checked = true;
    form.querySelector<HTMLInputElement>('[data-parameter]')!.value = 'my-imports';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(available.id, available.version, {enabled: true, defaults: {'document.inspect': {directory: 'my-imports'}}}));
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce());
    expect(f.dialog.querySelector<HTMLInputElement>('[name=enabled]')!.checked).toBe(true);
    expect(f.dialog.querySelector<HTMLInputElement>('[data-parameter]')!.value).toBe('my-imports');
    expect(f.dialog.querySelector<HTMLDetailsElement>('[data-package-guide]')!.open).toBe(true);
    expect(f.dialog.querySelector<HTMLDetailsElement>('[data-package-preferences]')!.open).toBe(true);
    expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册');
});

it('merges package versions, reads run history and toggles only user settings', async () => {
    let enabled = false;
    const configure = vi.fn(async (_id, _version, input) => {enabled = input.enabled;});
    const history = vi.fn(async () => [{id: 'run', toolId: 'document.inspect', version: '2', startedAt: 1000, durationMs: 120, status: 'succeeded' as const, collection: {version: 1 as const, complete: false, processed: 12, batchCount: 0}}]);
    const f = setup({toolPackages: {list: async () => [{...available, version: '0.1.0', status: 'available'},
        {...available, status: 'registered', configuration: {enabled, defaults: {}, tools: []}}, {...available, version: '2.0.0', status: 'available'}], ensure: vi.fn(), configure, history}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-toggle]')).not.toBeNull());
    expect(f.dialog.querySelectorAll('[data-package-id][class=tool-packages-dialog__item]')).toHaveLength(1);
    f.dialog.querySelector<HTMLButtonElement>('[data-package-toggle]')!.click();
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(available.id, available.version, {enabled: true, defaults: {}}));
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-toggle]')!.getAttribute('aria-pressed')).toBe('true'));
    f.dialog.querySelector<HTMLButtonElement>('[data-package-history]')!.click();
    await vi.waitFor(() => expect(history).toHaveBeenCalledWith(available.id, available.version));
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('120 ms'));
    expect(f.dialog.textContent).toContain('本批归档 0 项');
    expect(f.dialog.textContent).toContain('本轮累计处理 12 项');
    expect(f.dialog.textContent).toContain('待继续同步');
    expect(f.dialog.textContent).toContain('0.1.0'); expect(f.dialog.textContent).toContain('2.0.0');
});
it('keeps personal package enablement independent of workflow dependency checks', async () => {
    const configure = vi.fn(async () => {});
    const f = setup({toolPackages: {list: async () => [{...available, status: 'registered', configuration: {enabled: false, defaults: {}, disabledTools: ['document.inspect', 'other'], tools: [{id: 'document.inspect', parameters: []}]}}], ensure: vi.fn(), configure}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-toggle]')).not.toBeNull());
    expect(f.dialog.querySelector('[data-enable-dependency], [data-flow-ensure]')).toBeNull();
    f.dialog.querySelector<HTMLButtonElement>('[data-package-toggle]')!.click();
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(available.id, available.version, {enabled: true, defaults: {}, disabledTools: ['document.inspect', 'other']}));
});

it('shows progress, completion and installed state after reopening for bundled workflows', async () => {
    let finish!: (count: number) => void, installed = false;
    const installFlows = vi.fn(() => new Promise<number>(resolve => {finish = count => {installed = true; resolve(count);};}));
    const controls = {toolPackages: {list: async () => [{...available, status: 'registered' as const, flowCount: 2,
        flowResources: [{id: 'mail', name: 'Mail flow', installed}, {id: 'calendar', name: 'Calendar flow', installed}]}], ensure: vi.fn(), installFlows}};
    const f = setup(controls);
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-flows]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.click();
    expect(f.dialog.querySelector('[data-package-flows]')!.textContent).toContain('正在添加');
    expect(f.dialog.querySelector('[data-package-flows]')!.getAttribute('aria-busy')).toBe('true');
    f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.click(); expect(installFlows).toHaveBeenCalledOnce();
    finish(2);
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-flow-status]')!.textContent).toContain('已新增 2'));
    expect(f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.disabled).toBe(true);
    expect(f.dialog.querySelector('[data-package-flows]')!.textContent).toContain('已添加');
    f.dialog.close(); const reopened = setup(controls);
    await vi.waitFor(() => expect(reopened.dialog.querySelector('[data-package-flows]')!.textContent).toContain('已添加'));
    expect(reopened.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.disabled).toBe(true);
    expect(installFlows).toHaveBeenCalledOnce();
});
it('explains a zero-addition result and reports missing host capability instead of silent success', async () => {
    const f = setup({toolPackages: {list: async () => [{...available, status: 'registered', flowCount: 1}], ensure: vi.fn(), installFlows: async () => 0}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-flows]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-flow-status]')!.textContent).toContain('已在流程库中'));
    f.dialog.close();
    const unsupported = setup({toolPackages: {list: async () => [{...available, status: 'registered', flowCount: 1}], ensure: vi.fn()}});
    await vi.waitFor(() => expect(unsupported.dialog.querySelector('[data-package-flows]')).not.toBeNull());
    unsupported.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.click();
    await vi.waitFor(() => expect(unsupported.dialog.querySelector('[role=alert]')!.textContent).toContain('当前宿主不支持'));
    expect(unsupported.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.disabled).toBe(false);
});
it('refreshes actual library presence after a partially failed install and allows a retry', async () => {
    let partial = false;
    const installFlows = vi.fn(async () => {partial = true; throw new Error('FLOW_PUBLISH_UNAVAILABLE');});
    const f = setup({toolPackages: {list: async () => [{...available, status: 'registered', flowCount: 2,
        flowResources: [{id: 'one', name: 'First', installed: partial}, {id: 'two', name: 'Second', installed: false}]}], ensure: vi.fn(), installFlows}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-flows]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('[role=alert]')!.textContent).toContain('FLOW_PUBLISH_UNAVAILABLE'));
    expect(f.dialog.querySelector('[data-package-flow-status]')!.textContent).toContain('1/2');
    expect(f.dialog.querySelector<HTMLButtonElement>('[data-package-flows]')!.disabled).toBe(false);
});

it('activates a version immediately and keeps OAuth settings inside the active package', async () => {
    let activationId = '';
    const switchVersion = vi.fn(async (_id, _version, _expected, operationId) => {activationId = operationId;});
    const type: ToolConnectionType = {id: 'external-account', name: 'External account', description: '',
        fields: [{name: 'client', label: 'Client', required: true}, {name: 'secret', label: 'Secret', secret: true, required: true}, {name: 'refresh', label: 'Refresh', secret: true}],
        authorization: {kind: 'oauth2', authorizationEndpoint: 'https://fixture.invalid/authorize', tokenEndpoint: 'https://fixture.invalid/token',
            clientIdField: 'client', clientSecretField: 'secret', refreshTokenField: 'refresh', permissionGroups: [{id: 'read', label: 'Read', scopes: ['read']}]},
        application: {configured: false, canManage: true}};
    const save = vi.fn();
    const controls = {toolPackages: {list: async () => [
        ...(activationId ? [] : [{...available, version: '0.2.0', status: 'registered' as const}]),
        {...available, version: '0.2.1', status: activationId ? 'registered' as const : 'available' as const, canSwitch: !activationId, ...(activationId ? {activationId} : {}), connectionTypes: [type.id], connectionMethods: {[type.id]: ['browser', 'import'] as Array<'browser' | 'import'>}}],
        ensure: vi.fn(), switchVersion, connections: {snapshot: async () => ({types: [type], connections: []}), save, remove: vi.fn()}}};
    const f = setup(controls);
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-switch]')).not.toBeNull());
    const settings = f.dialog.querySelector('[data-connection-details="package:external-package"]')!;
    expect(settings.querySelector('[data-connection-method]')).not.toBeNull();
    expect(settings.querySelector('[data-form=oauthApplication]')).not.toBeNull();
    expect(f.dialog.querySelectorAll('[data-connection-details=connections]')).toHaveLength(1);
    f.dialog.querySelector<HTMLButtonElement>('[data-package-switch]')!.click();
    await vi.waitFor(() => expect(switchVersion).toHaveBeenCalledWith(available.id, '0.2.1', '0.2.0', expect.any(String)));
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('已升级至 0.2.1'));
    expect(f.dialog.textContent).not.toContain('重启'); expect(f.dialog.querySelector('[data-package-switch]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    f.dialog.close(); const reopened = setup(controls);
    await vi.waitFor(() => expect(reopened.dialog.textContent).toContain('已升级至 0.2.1'));
});

it('keeps factory-owned account settings visible even when an older package has no guide or connection YAML', async () => {
    const f = setup({toolPackages: {list: async () => [{...available, status: 'registered', connectionTypes: ['account']}], ensure: vi.fn(),
        connections: {snapshot: async () => ({types: [{id: 'account', name: 'Account', description: '', fields: [{name: 'key', label: 'Key', secret: true}]}], connections: []}), save: vi.fn(), remove: vi.fn()}}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-connection-details="package:external-package"] [data-form=sourceConnection]')).not.toBeNull());
    expect(f.dialog.querySelectorAll('[data-connection-details=connections]')).toHaveLength(1);
});
