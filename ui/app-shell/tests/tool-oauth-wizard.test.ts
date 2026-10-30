// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {ToolConnections, ToolConnectionType, ToolConnectionView, ToolAuthorizationView} from '@itookit/app-contracts/services';
import {showToolPackages} from '../src/toolbox/ToolPackagesDialog';

const pending: Promise<void>[] = [];
afterEach(async () => {
    document.querySelectorAll<HTMLDialogElement>('.tool-packages-dialog').forEach(dialog => dialog.close());
    await Promise.all(pending.splice(0)); document.body.replaceChildren(); vi.restoreAllMocks();
});
function fixture(admin = false, configured = true) {
    const type: ToolConnectionType = {id: 'fixture', name: 'External account', description: '', fields: [{name: 'client', label: 'Client', required: true},
        {name: 'secret', label: 'Secret', secret: true, required: true}, {name: 'refresh', label: 'Refresh', secret: true}, {name: 'directory', label: 'Directory'}],
        authorization: {kind: 'oauth2', authorizationEndpoint: 'https://fixture.invalid/authorize', tokenEndpoint: 'https://fixture.invalid/token',
            clientIdField: 'client', clientSecretField: 'secret', refreshTokenField: 'refresh', permissionGroups: [{id: 'read', label: 'Read', scopes: ['read:a']}]},
        application: {configured, canManage: admin, clientId: admin && configured ? 'application-client' : undefined, hasSecret: configured,
            redirectUri: configured ? 'https://nestos.fixture.invalid/api/tool-connections/callback' : undefined}};
    let connections: ToolConnectionView[] = [], operation: ToolAuthorizationView | undefined;
    const save = vi.fn(async input => {connections = [{...input, configuredSecrets: [], authorization: {connected: false, scopes: [], clientMode: 'application'}}];});
    const beginAuthorization = vi.fn(async (id, _groups, operationId) => {
        operation = {connectionId: id, operationId, status: 'pending', expiresAt: Date.now() + 60000, url: 'https://fixture.invalid/authorize?state=opaque'} as ToolAuthorizationView;
        connections[0].authorization!.operation = operation; return operation;
    });
    const saveApplication = vi.fn(async input => {type.application = {...type.application!, configured: true, clientId: input.clientId, hasSecret: true, redirectUri: input.redirectUri};});
    const port: ToolConnections = {snapshot: async () => ({types: [type], connections}), save, remove: vi.fn(), saveApplication, beginAuthorization,
        authorizationStatus: async () => operation!};
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const popup = {opener: {}, closed: false, close: vi.fn(), location: {replace: vi.fn()}};
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    pending.push(showToolPackages({toolPackages: {list: async () => [], ensure: vi.fn(), connections: port}}));
    return {dialog: document.querySelector<HTMLDialogElement>('.tool-packages-dialog')!, type, port, save, beginAuthorization, saveApplication, popup, open};
}
it('connects a new account in one action without requiring application credentials, a token or an alias', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.dialog.querySelector('[data-auth-begin]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-form=sourceConnection]')!;
    expect(form.querySelector('[name=client]')).toBeNull(); expect(form.querySelector('[name=secret]')).toBeNull(); expect(form.querySelector('[name=refresh]')).toBeNull();
    expect(f.dialog.querySelector('[data-form=oauthApplication]')).toBeNull();
    form.querySelector<HTMLButtonElement>('[data-auth-begin]')!.click();
    expect(f.open).toHaveBeenCalledOnce(); expect(f.popup.opener).toBeNull();
    await vi.waitFor(() => expect(f.popup.location.replace).toHaveBeenCalledWith('https://fixture.invalid/authorize?state=opaque'));
    const input = f.save.mock.calls[0][0]; expect(input.id).toMatch(/^[a-f0-9-]{36}$/); expect(input.values).toEqual({directory: ''});
    expect(f.beginAuthorization).toHaveBeenCalledWith(input.id, ['read'], expect.any(String));
    expect(f.dialog.querySelector('[data-connection-details=connections]')!.hasAttribute('open')).toBe(true);
});
it('keeps a clickable authorization fallback if the browser blocks the new tab', async () => {
    const f = fixture(); f.open.mockReturnValue(null);
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-auth-begin]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-auth-begin]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('a[href="https://fixture.invalid/authorize?state=opaque"]')).not.toBeNull());
    expect(f.beginAuthorization).toHaveBeenCalledOnce();
});
it('keeps a stable account identity across a failed save and failed status refresh', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.dialog.querySelector('[data-auth-begin]')).not.toBeNull());
    const snapshot = f.port.snapshot;
    f.port.snapshot = vi.fn().mockRejectedValueOnce(new Error('STATUS_TEMPORARILY_UNAVAILABLE')).mockImplementation(snapshot);
    f.save.mockRejectedValueOnce(new Error('SAVE_REPLY_LOST'));
    f.dialog.querySelector<HTMLButtonElement>('[data-auth-begin]')!.click();
    await vi.waitFor(() => expect(f.popup.close).toHaveBeenCalledOnce());
    f.dialog.querySelector<HTMLButtonElement>('[data-auth-begin]')!.click();
    await vi.waitFor(() => expect(f.beginAuthorization).toHaveBeenCalledOnce());
    expect(f.save.mock.calls[0][0].id).toBe(f.save.mock.calls[1][0].id);
});
it('requires a configured application and at least one scope before opening an authorization tab', async () => {
    const f = fixture(false, false); await vi.waitFor(() => expect(f.dialog.querySelector('[data-auth-begin]')).not.toBeNull());
    expect(f.dialog.querySelector<HTMLButtonElement>('[data-auth-begin]')!.disabled).toBe(true);
    expect(f.dialog.textContent).toContain('需管理员先配置'); expect(f.dialog.querySelector('[data-form=oauthApplication]')).toBeNull();
    expect(f.open).not.toHaveBeenCalled(); expect(f.beginAuthorization).not.toHaveBeenCalled();
});
it('requests reauthorization instead of displaying a historical success after the application changes', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.dialog.querySelector('[data-auth-begin]')).not.toBeNull());
    f.port.snapshot = async () => ({types: [f.type], connections: [{id: 'personal', type: 'fixture', name: 'Personal', values: {}, configuredSecrets: [],
        authorization: {connected: false, scopes: [], clientMode: 'application', operation: {operationId: 'previous', connectionId: 'personal', status: 'authorized', expiresAt: Date.now()}}}]});
    f.dialog.querySelector<HTMLButtonElement>('[data-packages-refresh]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-authorization-status=personal]')!.textContent).toContain('请重新连接账号'));
    expect(f.dialog.querySelector('[data-auth-revoke]')).toBeNull();
});
it('saves application configuration only from the administrator form and clears secrets after success', async () => {
    const f = fixture(true, false); await vi.waitFor(() => expect(f.dialog.querySelector('[data-form=oauthApplication]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-form=oauthApplication]')!;
    form.querySelector<HTMLInputElement>('[name=clientId]')!.value = 'new-client';
    form.querySelector<HTMLInputElement>('[name=clientSecret]')!.value = 'private-application-secret';
    form.querySelector<HTMLInputElement>('[name=redirectUri]')!.value = 'https://nestos.fixture.invalid/api/tool-connections/callback';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.saveApplication).toHaveBeenCalledWith({type: 'fixture', clientId: 'new-client', clientSecret: 'private-application-secret', redirectUri: 'https://nestos.fixture.invalid/api/tool-connections/callback'}));
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLInputElement>('[name=clientSecret]')!.value).toBe(''));
    expect(f.dialog.innerHTML).not.toContain('private-application-secret');
});
it('preserves entered application configuration on failure and closes an unused popup after an exchange cannot start', async () => {
    const f = fixture(true); f.saveApplication.mockRejectedValue(new Error('TOOL_AUTH_APPLICATION_STORAGE_DENIED'));
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-form=oauthApplication]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-form=oauthApplication]')!;
    form.querySelector<HTMLInputElement>('[name=clientSecret]')!.value = 'retry-secret';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.dialog.querySelector('[role=alert]')!.textContent).toContain('TOOL_AUTH_APPLICATION_STORAGE_DENIED'));
    expect(f.dialog.querySelector<HTMLInputElement>('[name=clientSecret]')!.value).toBe('retry-secret');
    f.beginAuthorization.mockRejectedValue(new Error('TOOL_AUTH_CLIENT_INVALID'));
    f.dialog.querySelector<HTMLButtonElement>('[data-auth-begin]')!.click();
    await vi.waitFor(() => expect(f.popup.close).toHaveBeenCalledOnce());
    expect(f.dialog.querySelector('[role=alert]')!.textContent).toContain('TOOL_AUTH_CLIENT_INVALID'); expect(f.save).toHaveBeenCalledOnce();
});
