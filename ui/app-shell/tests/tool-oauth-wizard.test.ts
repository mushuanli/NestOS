import {importConnection, sourceConnectionSettings} from '../src/configuration/tool-connections';
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
    const save = vi.fn(async input => {connections = [{...input,
        values: Object.fromEntries(type.fields.filter(field => !field.secret).map(field => [field.name, input.values[field.name] ?? ''])),
        configuredSecrets: type.fields.filter(field => field.secret && input.values[field.name]).map(field => field.name),
        authorization: {connected: Boolean(input.values.refresh), scopes: [], clientMode: input.values.client ? 'personal' : 'application'}}];});
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

it('imports a browser-local file, fills account identity and saves content without sending a local path', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.dialog.querySelector('[data-connection-details="personal:fixture"]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-connection-details="personal:fixture"] form')!;
    const upload = form.querySelector<HTMLInputElement>('[name=connectionImport]')!;
    const values = {client: 'desktop-client', secret: 'private-desktop-secret', refresh: 'private-refresh'};
    Object.defineProperty(upload, 'files', {value: [new File([JSON.stringify(values)], 'only-on-my-laptop.json', {type: 'application/json'})]});
    await importConnection(upload);
    const id = form.querySelector<HTMLInputElement>('[name=id]')!.value;
    expect(id).toMatch(/^[a-f0-9-]{36}$/); expect(form.querySelector<HTMLInputElement>('[name=name]')!.value).toBe('External account');
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    expect(f.save).toHaveBeenCalledWith({id, type: 'fixture', name: 'External account', values: {...values, directory: ''}});
    expect(JSON.stringify(f.save.mock.calls)).not.toContain('only-on-my-laptop');
    expect(f.beginAuthorization).not.toHaveBeenCalled();
});

it('opens package-declared local instructions with defaults and keeps web configuration out of that path', () => {
    const f = fixture(true, false);
    const guide = {version: 1 as const, title: 'Local setup', connectionTypes: ['fixture'], steps: [{title: 'Run on your computer', description: 'Use the same computer for the browser.',
        command: 'node tools/example/authorize.mjs', links: [{label: 'Create client', url: 'https://fixture.invalid/clients'}]}]};
    const container = document.createElement('div');
    container.innerHTML = sourceConnectionSettings({types: [f.type], connections: []}, true, [guide]);
    const local = container.querySelector<HTMLDetailsElement>('[data-connection-details="personal:fixture"]')!;
    expect(local.open).toBe(true); expect(local.textContent).toContain(guide.steps[0].command);
    expect(local.querySelector('a')!.href).toBe('https://fixture.invalid/clients');
    expect(local.querySelector('[data-auth-begin]')).toBeNull();
    expect(local.querySelector<HTMLInputElement>('[name=id]')!.type).toBe('hidden');
    expect(local.querySelector<HTMLInputElement>('[name=name]')!.value).toBe(f.type.name);
    expect(local.querySelector<HTMLDetailsElement>('form details')!.open).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('[data-connection-details="new:fixture"]')!.open).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('[data-connection-details="application:fixture"]')!.open).toBe(false);
    const unrelated = sourceConnectionSettings({types: [f.type], connections: []}, true, [{...guide, connectionTypes: ['another']}]);
    expect(unrelated).not.toContain(guide.steps[0].command);
});
it('asks for the authorization result before saving and retains imported credentials after a failed save', async () => {
    const f = fixture(false, false); await vi.waitFor(() => expect(f.dialog.querySelector('[data-local-import]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-local-import]')!;
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    expect(f.save).not.toHaveBeenCalled(); expect(form.querySelector('[data-import-status]')!.textContent).toContain('请先选择授权命令');
    const upload = form.querySelector<HTMLInputElement>('[name=connectionImport]')!;
    const values = {client: 'desktop-client', secret: 'private-desktop-secret', refresh: 'private-refresh'};
    Object.defineProperty(upload, 'files', {value: [new File([JSON.stringify(values)], 'result.json')]});
    await importConnection(upload); f.save.mockRejectedValueOnce(new Error('SAVE_TEMPORARILY_UNAVAILABLE'));
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.dialog.querySelector('[role=alert]')!.textContent).toContain('SAVE_TEMPORARILY_UNAVAILABLE'));
    const retry = f.dialog.querySelector<HTMLFormElement>('[data-local-import]')!;
    expect(retry.querySelector<HTMLInputElement>('[name=secret]')!.value).toBe(values.secret);
    expect(retry.querySelector<HTMLInputElement>('[name=refresh]')!.value).toBe(values.refresh);
    retry.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2));
    expect(f.save.mock.calls[0][0]).toEqual(f.save.mock.calls[1][0]); expect(f.beginAuthorization).not.toHaveBeenCalled();
});
it('rejects incomplete or malformed imports atomically without exposing their contents', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.dialog.querySelector('[data-local-import]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-local-import]')!, upload = form.querySelector<HTMLInputElement>('[name=connectionImport]')!;
    for (const [content, code] of [['{"secret":"sensitive-marker"', 'TOOL_CONNECTION_IMPORT_JSON'],
        [JSON.stringify({client: 'downloaded-client', secret: 'sensitive-marker'}), 'TOOL_CONNECTION_IMPORT_FIELDS']]) {
        Object.defineProperty(upload, 'files', {value: [new File([content], 'private-file.json')], configurable: true});
        await expect(importConnection(upload)).rejects.toMatchObject({code});
        expect(form.querySelector<HTMLInputElement>('[name=client]')!.value).toBe('');
        expect(form.querySelector<HTMLInputElement>('[name=secret]')!.value).toBe('');
        expect(form.textContent).not.toContain('sensitive-marker'); expect(form.textContent).not.toContain('private-file.json');
    }
    expect(f.save).not.toHaveBeenCalled(); expect(f.beginAuthorization).not.toHaveBeenCalled();
});
it('switches connection methods without displaying both setup paths', async () => {
    const f = fixture(true, false); await vi.waitFor(() => expect(f.dialog.querySelector('[data-connection-method]')).not.toBeNull());
    const select = f.dialog.querySelector<HTMLSelectElement>('[data-connection-method]')!;
    const web = f.dialog.querySelector<HTMLDetailsElement>('[data-method-panel=browser]')!, local = f.dialog.querySelector<HTMLDetailsElement>('[data-method-panel=import]')!;
    expect(select.value).toBe('import'); expect(web.hidden).toBe(true); expect(local.hidden).toBe(false);
    select.value = 'browser'; select.dispatchEvent(new Event('change', {bubbles: true}));
    expect(web.hidden).toBe(false); expect(web.open).toBe(true); expect(local.hidden).toBe(true);
});

it('shows saving and verification progress, reveals the saved account and keeps secrets out of the refreshed view', async () => {
    const f = fixture(false, false); await vi.waitFor(() => expect(f.dialog.querySelector('[data-local-import]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-local-import]')!, upload = form.querySelector<HTMLInputElement>('[name=connectionImport]')!;
    Object.defineProperty(upload, 'files', {value: [new File([JSON.stringify({client: 'desktop', secret: 'PRIVATE_SECRET', refresh: 'PRIVATE_REFRESH'})], 'result.json')]});
    await importConnection(upload);
    const id = form.querySelector<HTMLInputElement>('[name=id]')!.value;
    let finishSave!: () => void, finishVerify!: () => void;
    const save = f.save.getMockImplementation()!;
    f.save.mockImplementationOnce(async input => {await new Promise<void>(resolve => {finishSave = resolve;}); await save(input);});
    f.port.verify = vi.fn(async accountId => {
        await new Promise<void>(resolve => {finishVerify = resolve;});
        const result = {status: 'verified' as const, checkedAt: Date.now()};
        (await f.port.snapshot()).connections.find(account => account.id === accountId)!.verification = result; return result;
    });
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    expect(f.dialog.querySelector('[data-connection-feedback]')!.textContent).toContain('正在保存');
    expect(f.dialog.querySelector<HTMLButtonElement>('[data-local-import] [type=submit]')!.disabled).toBe(true);
    finishSave();
    await vi.waitFor(() => expect(f.port.verify).toHaveBeenCalledWith(id));
    expect(f.dialog.querySelector('[data-connection-feedback]')!.textContent).toContain('连接已保存');
    expect(f.dialog.querySelector('[data-connection-feedback]')!.textContent).toContain('正在验证');
    expect(f.dialog.querySelector<HTMLDetailsElement>(`[data-connection-details="account:${id}"]`)!.open).toBe(true);
    expect(f.dialog.querySelector<HTMLDetailsElement>('[data-connection-details="personal:fixture"]')!.open).toBe(false);
    finishVerify();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-connection-verification]')!.textContent).toContain('授权验证通过'));
    expect(f.save).toHaveBeenCalledOnce(); expect(f.dialog.innerHTML).not.toMatch(/PRIVATE_SECRET|PRIVATE_REFRESH/);
    expect(f.dialog.querySelector('summary')!.textContent).not.toContain('令牌由宿主自动刷新');
});

it('keeps the connection saved when verification fails and lets users retry verification without saving again', async () => {
    const f = fixture(false, false); await vi.waitFor(() => expect(f.dialog.querySelector('[data-local-import]')).not.toBeNull());
    const form = f.dialog.querySelector<HTMLFormElement>('[data-local-import]')!, upload = form.querySelector<HTMLInputElement>('[name=connectionImport]')!;
    Object.defineProperty(upload, 'files', {value: [new File([JSON.stringify({client: 'desktop', secret: 'PRIVATE_SECRET', refresh: 'PRIVATE_REFRESH'})], 'result.json')]});
    await importConnection(upload);
    let fail = true;
    f.port.verify = vi.fn(async id => {
        const result = {status: fail ? 'failed' as const : 'verified' as const, checkedAt: Date.now(), ...(fail ? {code: 'TOOL_AUTH_REAUTHORIZE_REQUIRED'} : {})};
        (await f.port.snapshot()).connections.find(account => account.id === id)!.verification = result; return result;
    });
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-connection-verification]')!.textContent).toContain('请重新授权'));
    expect(f.dialog.querySelector('[data-connection-feedback]')!.textContent).toContain('连接已保存');
    expect(f.dialog.querySelector('[data-connection-verification]')!.textContent).toContain('TOOL_AUTH_REAUTHORIZE_REQUIRED');
    expect((await f.port.snapshot()).connections).toHaveLength(1); expect(f.save).toHaveBeenCalledOnce();
    fail = false; f.dialog.querySelector<HTMLButtonElement>('[data-connection-verify]')!.click();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-connection-verification]')!.textContent).toContain('授权验证通过'));
    expect(f.save).toHaveBeenCalledOnce(); expect(f.port.verify).toHaveBeenCalledTimes(2);
});
