// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import type { ProjectSyncService } from '@itookit/app-core';
import type { StoredFilePlan, SyncState } from '@itookit/vfs-sync';
import { ProjectSyncMenu } from '../src/projects/sync/menu';
import { showSyncPreview } from '../src/projects/sync/preview';
import { ProjectNavigation } from '../src/projects/ProjectNavigation';

const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
    for (const method of ['showModal', 'close']) {
        descriptors.set(method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
        Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: vi.fn() });
    }
});
afterEach(() => {
    document.body.replaceChildren(); vi.restoreAllMocks();
    for (const [method, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
});
function state(): SyncState {
    return { schemaVersion: 1, binding: { bindingId: 'binding', bindingRevision: '1', locatorRevision: '1', policyRevision: '1', scopeRevision: '1',
        state: 'active', authorityId: 'authority', namespaceId: 'personal', historyEpoch: 'epoch', projectId: 'cloud', localProjectId: 'p',
        replicaId: 'replica', sourceId: 'idb', root: '/work', datasetId: 'files', direction: 'both' }, nextSeq: '1', baseline: [], history: [] };
}
function action(menu: ProjectSyncMenu, key: string) {
    const item = menu.items('p').find(item => item.type !== 'separator' && item.id === 'project-sync-' + key);
    if (!item || item.type === 'separator') throw new Error(key); return item;
}
function button(label: string): HTMLButtonElement {
    const result = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label);
    if (!result) throw new Error(label); return result;
}
const prepared = (): StoredFilePlan => ({ id: 'original', bindingToken: 'token', scopeToken: 'scope', changesCursor: 'cursor',
    head: { generation: '1', manifestHash: 'a'.repeat(64) }, lifecycleRevision: '1', handle: {}, phase: 'prepared',
    plan: { manifest: { format: 'fs-agent.files', version: 1, entries: [] }, actions: [], degraded: [],
        conflicts: [{ path: '<script>file</script>', code: 'CONTENT_CONFLICT' }] } });

it('keeps setup feedback accessible and blocks new sync while a result is pending', async () => {
    const service = { status: vi.fn(async () => state()) } as unknown as ProjectSyncService;
    const menu = new ProjectSyncMenu({ service }, new AbortController().signal, vi.fn(), vi.fn());
    await menu.refresh('p'); expect(action(menu, 'now').disabled).toBe(false);
    const pending = state(); pending.activePlanId = 'pending'; vi.mocked(service.status).mockResolvedValue(pending);
    await menu.refresh('p'); expect(action(menu, 'now').disabled).toBe(true); expect(action(menu, 'recover').disabled).toBe(false);
    vi.mocked(service.status).mockRejectedValue({ code: 'SYNC_CONTROL_MISSING' }); await menu.refresh('p');
    expect(action(menu, 'setup').disabled).toBe(false);
    const configured = new ProjectSyncMenu({ service, setup: vi.fn() }, new AbortController().signal, vi.fn(), vi.fn());
    await configured.refresh('p'); expect(action(configured, 'setup').disabled).toBe(false);
});
it.each(['setup', 'status'])('opens an explanation for %s when the app has no sync runtime', async key => {
    const controller = new AbortController(), report = vi.fn();
    const menu = new ProjectSyncMenu({}, controller.signal, report, vi.fn());
    await menu.refresh('p'); expect(action(menu, key).disabled).toBe(false);
    action(menu, key).onClick?.({} as never);
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain(t('project.sync.serviceUnavailable')));
    expect(report).not.toHaveBeenCalled(); controller.abort();
});
it('explains a missing setup port and invokes an available host setup with the selected project', async () => {
    const service = { status: vi.fn(async () => { throw { code: 'BINDING_NOT_FOUND' }; }) } as unknown as ProjectSyncService;
    const controller = new AbortController(), changed = vi.fn(async () => {}), setup = vi.fn(async () => {});
    const menu = new ProjectSyncMenu({ service }, controller.signal, vi.fn(), changed);
    await menu.refresh('p'); action(menu, 'setup').onClick?.({} as never);
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain(t('project.sync.setupUnavailable')));
    const configured = new ProjectSyncMenu({ service, setup }, controller.signal, vi.fn(), changed);
    await configured.refresh('p'); action(configured, 'setup').onClick?.({} as never);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(setup).toHaveBeenCalledWith('p', controller.signal); controller.abort();
});
it('opens status before a slow query and displays a query error inside the dialog', async () => {
    let fail!: (reason: Error) => void;
    const service = { status: vi.fn(() => new Promise<SyncState>((_, reject) => { fail = reject; })) } as unknown as ProjectSyncService;
    const controller = new AbortController(), menu = new ProjectSyncMenu({ service }, controller.signal, vi.fn(), vi.fn());
    const opened = menu.openStatus('p');
    expect(document.querySelector('dialog [role="status"]')?.textContent).toBe(t('project.sync.working'));
    fail(new Error('disk unavailable')); await opened;
    expect(document.querySelector('dialog [role="status"]')?.textContent).toBe(t('project.sync.statusFailed', { error: 'disk unavailable' }));
    expect(menu.items('p').some(item => item.type !== 'separator' && item.id === 'project-sync-setup')).toBe(false);
    controller.abort();
});
it('requires a second confirmation of resolved preview and never executes when opening the dialog', async () => {
    const resolved = prepared(); resolved.id = 'resolved'; resolved.plan.conflicts = [];
    const service = { resolve: vi.fn(async () => resolved), execute: vi.fn(async () => ({ warnings: [] })) } as unknown as ProjectSyncService;
    const controller = new AbortController(), changed = vi.fn(async () => {});
    showSyncPreview(service, 'p', prepared(), controller.signal, changed);
    expect(service.execute).not.toHaveBeenCalled(); expect(document.querySelector('script')).toBeNull();
    const choice = document.querySelector('dialog select') as HTMLSelectElement; choice.value = 'local';
    button(t('project.sync.execute')).click();
    await vi.waitFor(() => expect(service.resolve).toHaveBeenCalledWith('p', 'original', { '<script>file</script>': 'local' }));
    await vi.waitFor(() => expect(button(t('project.sync.execute')).disabled).toBe(false));
    expect(service.execute).not.toHaveBeenCalled(); button(t('project.sync.execute')).click();
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalledWith('p', 'resolved'));
    expect(changed).toHaveBeenCalledWith(0); controller.abort(); expect(document.querySelector('dialog')).toBeNull();
});
it('requires explicit unbind confirmation and sends the originally selected project identity', async () => {
    const service = { status: vi.fn(async () => state()), unbind: vi.fn(async () => {}) } as unknown as ProjectSyncService;
    const controller = new AbortController(), report = vi.fn();
    const menu = new ProjectSyncMenu({ service }, controller.signal, report, vi.fn(async () => {})); await menu.refresh('p');
    action(menu, 'unbind').onClick?.({} as never);
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull()); expect(service.unbind).not.toHaveBeenCalled();
    button(t('project.sync.unbindConfirm')).click(); await vi.waitFor(() => expect(service.unbind).toHaveBeenCalledWith('p'));
    expect(report).not.toHaveBeenCalled(); controller.abort();
});
it('keeps a failed status query unknown rather than presenting it as a missing binding', async () => {
    const service = { status: vi.fn(async () => { throw new Error('I/O'); }) } as unknown as ProjectSyncService;
    const menu = new ProjectSyncMenu({ service, setup: vi.fn() }, new AbortController().signal, vi.fn(), vi.fn());
    await expect(menu.refresh('p')).rejects.toThrow('I/O');
    expect(menu.items('p').some(item => item.type !== 'separator' && item.id === 'project-sync-setup')).toBe(false);
});
it('exposes an invalid sync MCP as a project issue while retaining status and offline unbind', async () => {
    const bound = state(); bound.binding.connectionId = 'deleted';
    const service = {status: vi.fn(async () => bound)} as unknown as ProjectSyncService;
    const controller = new AbortController(), changed = vi.fn();
    const menu = new ProjectSyncMenu({service, connection: () => ({reason: 'mcp-not-found'})}, controller.signal, vi.fn(), vi.fn(), changed);
    await menu.refresh('p'); await menu.refresh('p'); expect(changed).toHaveBeenCalledOnce();
    expect(menu.indicator('p')?.issues).toContain(t('project.sync.issue.connectionMissing'));
    expect(action(menu, 'now').disabled).toBe(true); expect(action(menu, 'unbind').disabled).toBe(false);
    await menu.openStatus('p'); expect(document.querySelector('dialog')?.textContent).toContain(t('project.sync.issue.connectionMissing'));
    controller.abort();
});
it('opens current-project actions from the sidebar title button and selector context menu', async () => {
    const project = { name: 'Project', path: '/project', project: { id: 'p' } };
    const projects = { sessions: { navigation: async () => ({ sessions: [], folders: [], pending: [], roots: new Map() }) },
        forFolder: async () => project, list: async () => [project] };
    const projectMenu = vi.fn(async () => {}), ui = { setTitle: vi.fn(), refreshList: vi.fn(), expandPath: vi.fn(async () => {}), loadDirectories: vi.fn(async () => {}) };
    const navigation = new ProjectNavigation(projects as never, () => ui as never, { projectMenu, createProject: vi.fn(), createSession: vi.fn(),
        createChild: vi.fn(), importItems: vi.fn(), exportItems: vi.fn(), report: vi.fn(), retryDeletions: vi.fn(), contentChanged: vi.fn() });
    await navigation.sync('/project', { project: project as never });
    expect(navigation.header.querySelector(`button[aria-label="${t('project.sync.status')}"]`)).toBeNull();
    expect(navigation.header.textContent).not.toContain(t('project.sync.unboundShort'));
    const menu = [...navigation.header.querySelectorAll<HTMLButtonElement>('details button')]
        .find(button => button.textContent === t('project.sync.projectActions'))!;
    expect(menu.hidden).toBe(false); menu.click(); expect(projectMenu.mock.calls[0]?.[1]).toBe(project);
    navigation.header.querySelector('select')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(projectMenu).toHaveBeenCalledTimes(2);
    navigation.destroy();
});

it('keeps single-direction choices constrained and cannot submit a closed preview', () => {
    const service = { execute: vi.fn() } as unknown as ProjectSyncService;
    const controller = new AbortController();
    showSyncPreview(service, 'p', prepared(), controller.signal, vi.fn(), 'upload');
    const remote = document.querySelector<HTMLOptionElement>('option[value="remote"]'); expect(remote?.disabled).toBe(true);
    const execute = button(t('project.sync.execute')); controller.abort(); execute.click();
    expect(service.execute).not.toHaveBeenCalled();
});
it('discards an older async status result and exposes expired-receipt reconciliation separately', async () => {
    let complete!: (value: SyncState) => void;
    const service = { status: vi.fn(() => new Promise<SyncState>(resolve => { complete = resolve; })) } as unknown as ProjectSyncService;
    const menu = new ProjectSyncMenu({ service }, new AbortController().signal, vi.fn(), vi.fn());
    const first = menu.refresh('p'), pending = state(); pending.pending = { terminalExpired: true, command: { target: 'publish', body: {
        operationId: 'op', replicaId: 'replica', opSeq: '1', authorityId: 'authority', historyEpoch: 'epoch' } } };
    vi.mocked(service.status).mockResolvedValue(pending); await menu.refresh('p'); complete(state()); await first;
    expect(action(menu, 'now').disabled).toBe(true); expect(action(menu, 'reconcile').disabled).toBe(false);
    expect(menu.items('p').some(item => item.type !== 'separator' && item.id === 'project-sync-recover')).toBe(false);
});
it('compares captured text safely and exposes the two replacement destinations',async()=>{
    const initial=prepared();initial.plan.conflicts[0].local={kind:'file',path:'<script>file</script>',hash:'a'.repeat(64),size:'5'};
    initial.plan.conflicts[0].remote={kind:'file',path:'<script>file</script>',hash:'b'.repeat(64),size:'6'};
    const service={compare:vi.fn(async()=>({path:'<script>file</script>',baseline:{kind:'missing'},local:{kind:'file',content:{text:'local\n'}},remote:{kind:'file',content:{text:'<img src=x onerror=alert(1)>\n'}}})),execute:vi.fn()} as unknown as ProjectSyncService;
    const controller=new AbortController();showSyncPreview(service,'p',initial,controller.signal,vi.fn());
    button(t('project.sync.compareContent')).click();await vi.waitFor(()=>expect(document.querySelectorAll('pre').length).toBe(2));
    expect(service.compare).toHaveBeenCalledWith('p','original','<script>file</script>');expect(document.querySelector('img')).toBeNull();expect(document.querySelector('.project-sync__line--changed')).not.toBeNull();
    expect(service.execute).not.toHaveBeenCalled();controller.abort();
});
it('changes direction in the preview, invalidates its token and requires a fresh review',async()=>{
    const initial=prepared(),fresh=prepared();fresh.id='fresh';fresh.bindingToken='new-token';fresh.plan.conflicts=[];
    const service={bindingToken:()=>'token',configure:vi.fn(async()=>{}),preview:vi.fn(async()=>fresh),execute:vi.fn(async()=>({conflicts:[],warnings:[]}))} as unknown as ProjectSyncService;
    const controller=new AbortController();showSyncPreview(service,'p',initial,controller.signal,vi.fn(async()=>{}));
    const select=document.querySelector<HTMLSelectElement>(`select[aria-label="${t('project.sync.direction')}"]`)!;
    select.value='download';select.dispatchEvent(new Event('change'));expect(button(t('project.sync.execute')).disabled).toBe(true);
    await vi.waitFor(()=>expect(service.configure).toHaveBeenCalledWith('p','token',{direction:'download'}));
    await vi.waitFor(()=>expect(button(t('project.sync.execute')).disabled).toBe(false));expect(service.execute).not.toHaveBeenCalled();
    button(t('project.sync.execute')).click();await vi.waitFor(()=>expect(service.execute).toHaveBeenCalledWith('p','fresh'));controller.abort();
});
