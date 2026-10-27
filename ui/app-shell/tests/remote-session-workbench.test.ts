import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { MemoryBackend, createFileSystemSource, FSError } from '@itookit/vfs-core';
import { createApplicationRuntime, remoteSessionPath, folderBrowserPath } from '@itookit/app-core';
import { HarnessConversation, type HarnessClient, type ProjectClient } from '@itookit/nestos-node-driver';
import {createLLMFactory} from '../../llm-ui-adapter/src/chat';
import type { EditorOptions } from '@itookit/ui-common';
import type { VFSUIShell } from '@itookit/vfs-ui';
import { projectConversationEntryPath, projectConversationsPath } from '@itookit/app-contracts';

const dialogMethods = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches:false,addEventListener() {},removeEventListener() {}}));
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    Object.defineProperties(Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new DOMRect()}});
    for (const method of ['showModal', 'close']) {
        dialogMethods.set(method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
        Object.defineProperty(HTMLDialogElement.prototype, method, {configurable: true, value: vi.fn()});
    }
});
afterEach(() => {
    vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (Range.prototype as any).getClientRects; delete (Range.prototype as any).getBoundingClientRect;
    for (const [method, descriptor] of dialogMethods) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
});

it('browses mounted native history pages, opens their conversations and routes a project draft remotely', async () => {
    const files = new MemoryBackend(); await files.mkdir('/project');
    const fileSource = await createFileSystemSource({backend: files, viewId: 'server-files', access: 'rw'});
    const record = {id:'server-project',name:'Notes',alias:'docs',path:'project',access:'rw' as const,revision:1,mounts:[]};
    const profile = {id:'codex',kind:'codex',projectRuntime:true,workspaces:[{id:record.id}],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true,fork:true}};
    const native = {id:'native',title:'Native session',cwd:'/projects/server-project',status:'idle',createdAt:1791458500000,updatedAt:1791458565000,resumable:true,owned:true};
    const sessionList=[{...native,id:'earlier-native',title:'A much older session',updatedAt:1791458500000}, native];
    const peer: HarnessClient = {subscribe:vi.fn(() => () => {}),profiles:vi.fn(async () => ({epoch:'e',profiles:[profile]})),list:vi.fn(async (_profile, query) => query?.cursor
        ? {sessions:[{...native,id:'older',title:'Older native session'}],nextCursor:null}
        : {sessions:[...sessionList],nextCursor:'older/before+='}),read:vi.fn(async () => ({session:{...native},turns:[{items:[{id:'a',type:'agentMessage',text:'Remote native history'}]}]})),
        fork:vi.fn(async (_profile,id,name) => {const session={...native,id:'branched-native',title:name ?? 'Alternative',parentSessionId:id};sessionList.push(session);return {session};}),create:vi.fn(async () => {const session={...native,id:'new-native'};sessionList.push(session);return {session};}),resume:vi.fn(async () => ({session:{...native}})),turn:vi.fn(async () => ({turnId:'t'})),eventSnapshot:vi.fn(async () => ({epoch:'ev',cursor:0,gap:false,events:[],requests:[]})),respond:vi.fn(),interrupt:vi.fn(),operation:vi.fn(),close:vi.fn(async () => {})};
    vi.mocked(peer.read).mockImplementation(async (_profile,id) => ({session:{...native,id},turns:[{items:[{id:'a',type:'agentMessage',text:'Remote native history'}]}]}));
    const client = {register:async () => record,read:async () => record,roots:async () => ({roots: [{alias: 'docs', access: 'rw'}]}),harness:() => peer,close:async () => {}} as unknown as ProjectClient;
    const runtime = await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web',remoteSourceProvider:{setCredential() {},resolveCredential:()=>'secret',dispose:async () => {},projects:() => client,
        conversation:(...args) => new HarnessConversation(...args),discover:async connection => ({version:1,fileProtocol:'fs-agent-http-v1',httpEndpoint:connection.endpoint.replace(/\/mcp$/,''),serverId:'node',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'}),
        open:async () => ({fs: fileSource.fs, dispose: async () => {}})}});
    const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init) => {
        if (init?.method !== 'POST') return new Response(null,{status:405});
        const message = JSON.parse(String(init.body));
        const result = message.method === 'server/discover' ? {supportedVersions:['2026-07-28'],capabilities:{tools:{}},
            _meta:{'itookit/pi-agent':{version:1,fileProtocol:'fs-agent-http-v1',httpEndpoint:'https://files.test',serverId:'node',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'}}} : {tools:[]};
        return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{resultType:'complete',ttlMs:0,cacheScope:'private',...result}}),{headers:{'content-type':'application/json'}});
    });
    const sidebar=document.createElement('div'),main=document.createElement('div');document.body.append(sidebar,main);
    const factory = vi.fn(createLLMFactory(runtime.agentService, {sessionRepository: runtime.sessionRepository,
        sessionManager: runtime.sessionManager, commandBus: runtime.commandBus}));
    const workbench=createTestWorkbench({ sidebar,container:main,repository:runtime.sessionRepository,files:runtime.sessionFiles,projects:runtime.projects,kernel:runtime.kernel.kernel,factory,onSelect() {},hostContext:undefined,fileFactory:factory});
    try {
        const remote=runtime.projects.remoteMounts!,connection=await remote.saveConnection({name:'Server',endpoint:'https://files.test',username:'u'},'secret');
        const project=await runtime.projects.createRemote('Notes',null,connection,'/docs/project','rw');
        const preview = (resource: string) => projectConversationEntryPath(projectConversationsPath(project.path, {recent: true}), resource);
        await workbench.start();
        const selector = sidebar.querySelector<HTMLSelectElement>('.workbench-project-navigation select')!;
        const initialScope = selector.value;
        const localPath = folderBrowserPath((await runtime.projects.current())!.path), remotePath = folderBrowserPath(project.path);
        await workbench.openResource(localPath);
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        selector.value = remotePath; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(remotePath));
        await vi.waitFor(() => expect(selector.value).toBe(remotePath));
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${preview(remoteSessionPath(project.path, 'codex', 'native'))}"]`)).not.toBeNull());
        expect(sidebar.querySelector(`[data-item-id="${remoteSessionPath(project.path, 'codex')}"]`)).toBeNull();
        expect(sidebar.querySelector(`[data-item-id="${remoteSessionPath(project.path)}"]`)).toBeNull();
        expect(main.querySelector('.workbench-tabs__panel:not([hidden])')!.textContent).toContain('Native session');
        expect(main.querySelector(`.workbench-tabs__panel:not([hidden]) [data-resource-id="${remoteSessionPath(project.path)}"]`)).toBeNull();
        selector.value = '/'; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('/'));
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${remotePath}"]`)).not.toBeNull());
        const remoteProjectRow = sidebar.querySelector<HTMLElement>(`[data-item-id="${remotePath}"] .vfs-directory-item__header`)!;
        expect(remoteProjectRow).not.toBeNull(); remoteProjectRow.click();
        expect(workbench.getActiveResourceId()).toBe('/');
        remoteProjectRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(remotePath));
        await vi.waitFor(() => expect(selector.value).toBe(remotePath));
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        expect([...main.querySelectorAll<HTMLButtonElement>('.workbench-tabs__panel:not([hidden]) button')]
            .some(button => button.getAttribute('aria-label') === t('project.createSession'))).toBe(true);
        selector.value = initialScope; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(initialScope));
        const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
        const driver = (workbench as unknown as {navigationFiles: {driver: {getChildren(path: string): Promise<unknown[]>}}}).navigationFiles.driver;
        const children = driver.getChildren.bind(driver), failure = new FSError('EIO', 'Remote directory unavailable');
        const listFailure = vi.spyOn(driver, 'getChildren').mockImplementation(async path => {
            if (path === remotePath) throw failure;
            return children(path);
        });
        try {
            await expect(workbench.openResource(remotePath, {reload: true})).rejects.toBe(failure);
            expect(workbench.getActiveResourceId()).toBe(remotePath);
            expect(selector.value).toBe(remotePath);
            expect(main.querySelector('.workbench-tabs__panel:not([hidden])')!.textContent).toContain('Remote directory unavailable');
            expect(diagnostic.mock.calls.some(([message, details]) => String(message).includes('[itookit/nestos-node]')
                && details?.stage === 'project-open' && details?.projectId === project.project.id && details?.code === 'EIO')).toBe(true);
        } finally {listFailure.mockRestore(); diagnostic.mockRestore();}
        await workbench.openResource(remotePath);
        expect(workbench.getActiveResourceId()).toBe(remotePath);
        await workbench.openResource(initialScope);
        const activePanel = () => main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
        const profilePath = remoteSessionPath(project.path,'codex'), morePath = profilePath + '/@page:older%2Fbefore%2B%3D';
        await workbench.openResource(profilePath, {preserveProject: true});
        expect(main.textContent).toContain('Native session');
        const create = () => activePanel().querySelector<HTMLButtonElement>('[data-directory-action="enabled"]');
        expect(create()?.title).toBe(t('project.createSession'));
        expect(create()?.getAttribute('aria-label')).toBe(t('project.createSession'));
        create()!.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('draft:' + project.project.id));
        activePanel().querySelector<HTMLButtonElement>('.llm-input__agent-trigger')!.click();
        expect(document.querySelector('.llm-popup--visible')?.textContent).toContain(t('harness.remoteAgents'));
        expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('codex'); document.body.click();
        expect(activePanel().querySelector('[data-execution-target]')).toBeNull();
        expect(peer.create).not.toHaveBeenCalled(); expect(peer.turn).not.toHaveBeenCalled();
        await workbench.openResource(profilePath, {preserveProject: true});
        const sidebarCreate = sidebar.querySelector<HTMLButtonElement>('.workbench-project-navigation__create')!;
        await vi.waitFor(() => expect(sidebarCreate.hidden).toBe(false));
        expect(sidebarCreate.title).toBe(t('project.createSession')); sidebarCreate.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('draft:' + project.project.id));
        expect(peer.create).not.toHaveBeenCalled(); expect(peer.turn).not.toHaveBeenCalled();
        await workbench.openResource(profilePath + '/@archived', {preserveProject: true});
        expect(create()).not.toBeNull(); await vi.waitFor(() => expect(sidebarCreate.hidden).toBe(false));
        await workbench.openResource(profilePath, {preserveProject: true});
        const list = activePanel().querySelector('.workbench-directory__table')!;
        expect(list.querySelector('[data-column="modified"]')?.getAttribute('aria-sort')).toBe('descending');
        const paths = [...list.querySelectorAll<HTMLTableRowElement>('[data-resource-id]')].map(row => row.dataset.resourceId);
        expect(paths[0]).toBe(profilePath + '/@new');
        expect(paths.indexOf(remoteSessionPath(project.path,'codex','native'))).toBeLessThan(paths.indexOf(remoteSessionPath(project.path,'codex','earlier-native')));
        const nativeRow = list.querySelector<HTMLTableRowElement>(`[data-resource-id="${remoteSessionPath(project.path,'codex','native')}"]`)!;
        expect(nativeRow.cells[2].textContent).not.toContain('1970'); expect(nativeRow.cells[2].textContent).not.toBe('—');
        expect(nativeRow.querySelector('button')!.title).toContain(t('workbench.created'));
        expect(nativeRow.querySelector('button')!.title).toContain(t('workbench.modified'));
        sessionList.push({...native, id: 'refreshed-native', title: 'Fresh native session'});
        await workbench.refresh();
        expect(activePanel().textContent).toContain('Fresh native session');
        sessionList.pop();
        await workbench.openResource(morePath, {preserveProject: true});
        expect(main.textContent).toContain('Older native session');
        expect(peer.list).toHaveBeenCalledWith('codex',{cursor:'older/before+='},expect.anything());
        await workbench.openResource(morePath + '/older');
        expect(selector.value).toBe(initialScope);
        expect(main.textContent).toContain('Remote native history');
        expect(peer.read).toHaveBeenCalledWith('codex','older',expect.anything());
        await vi.waitFor(() => expect(selector.disabled).toBe(false));
        selector.value = '/'; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('/'));
        const ui = (workbench as unknown as {sidebarUI: VFSUIShell}).sidebarUI;
        await ui.expandPath(profilePath);
        const nativePath = remoteSessionPath(project.path,'codex','native');
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${preview(nativePath)}"] .vfs-node-item__title`)?.textContent).toBe('Native session'));
        const nativeItem = sidebar.querySelector(`[data-item-id="${preview(nativePath)}"]`)!;
        expect(nativeItem.textContent).toContain(t('workbench.modified')); expect(nativeItem.textContent).toContain(t('workbench.created'));
        expect(nativeItem.textContent).not.toContain('1970');
        const visible = [...sidebar.querySelectorAll<HTMLElement>('[data-item-type="file"][data-item-id]')].map(item => item.dataset.itemId);
        expect(visible.indexOf(preview(nativePath))).toBeLessThan(visible.indexOf(preview(remoteSessionPath(project.path,'codex','earlier-native'))));
        await workbench.openResource(remoteSessionPath(project.path,'codex','native'));
        expect(main.textContent).toContain('Remote native history');expect(main.textContent).toContain('Server');
        expect(main.querySelector('[data-conversation-source="codex"]')?.textContent).toContain('Codex');
        expect(selector.value).toBe('/');
        expect(factory.mock.calls.at(-1)![1].conversation).toBeDefined();expect(peer.resume).not.toHaveBeenCalled();
        const collapsed = sidebar.classList.contains('is-collapsed');
        const toggle = activePanel().querySelectorAll<HTMLButtonElement>('#llm-btn-sidebar')[0]!;
        expect(toggle.hidden).toBe(false); toggle.click();
        await vi.waitFor(() => expect(sidebar.classList.contains('is-collapsed')).toBe(!collapsed));
        toggle.click(); await vi.waitFor(() => expect(sidebar.classList.contains('is-collapsed')).toBe(collapsed));
        activePanel().querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
        await vi.waitFor(() => expect(activePanel().querySelector('.remote-conversation__branch-create')).not.toBeNull());
        const branchName=activePanel().querySelector<HTMLInputElement>('.remote-conversation__branches input')!;branchName.value='Alternative';
        const forkButton=[...activePanel().querySelectorAll('button')].find(button=>button.textContent===t('harness.createBranch'))!;
        expect(forkButton.disabled).toBe(false);forkButton.click();
        await vi.waitFor(()=>expect(workbench.getActiveResourceId()).toBe(remoteSessionPath(project.path,'codex','branched-native')));
        expect(peer.fork).toHaveBeenCalledWith('codex','native','Alternative',expect.anything());
        expect(selector.value).toBe('/');
        expect(main.textContent).toContain('Remote native history');
        activePanel().querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
        await vi.waitFor(()=>expect(activePanel().querySelectorAll('.llm-branch-dropdown__item')).toHaveLength(2));
        expect(activePanel().querySelector('.llm-branch-dropdown__item.is-current')?.getAttribute('data-branch-name')).toBe('branched-native');
        activePanel().querySelector<HTMLElement>('[data-branch-name="native"]')!.click();
        await vi.waitFor(()=>expect(workbench.getActiveResourceId()).toBe(remoteSessionPath(project.path,'codex','native')));
        expect(selector.value).toBe('/');
        const folder=await runtime.projects.sessionFolder(project);
        const controls=(workbench as unknown as {remoteAgentControls(folder:string):import('@itookit/ui-common').RemoteAgentControls}).remoteAgentControls(folder);
        const remoteId=(await controls.list())[0].id;expect(remoteId).toContain('remote:');
        const before=(await runtime.sessionRepository.list()).length;
        await workbench.startSessionDraft(remotePath, undefined, remoteId);
        const shell = workbench as any, draftTab = shell.tabs.current, draftEditor = shell.editor;
        const mount = draftTab.panel.querySelector('.session-editor-mount'), textarea = mount.querySelector('.llm-input__textarea');
        const history = mount.querySelector('#llm-ui-history'), uuid = mount.dataset.conversationId;
        const composer = await runtime.projects.drafts.open(project.project.id, folder);
        expect(uuid).toBe(composer.id);
        let accept!: () => void;
        const delayed = new Promise<void>(resolve => {accept = resolve;});
        vi.mocked(peer.turn).mockImplementationOnce(async () => {await delayed; return {turnId: 't'};});
        textarea.value = 'remote task'; textarea.dispatchEvent(new Event('input', {bubbles: true}));
        mount.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
        try {
            await vi.waitFor(() => expect(peer.turn).toHaveBeenCalledOnce());
            expect(workbench.getActiveResourceId()).toBe('draft:' + project.project.id);
            textarea.value = 'Next remote message'; textarea.dispatchEvent(new Event('input', {bubbles: true}));
            textarea.focus(); textarea.setSelectionRange(4, 4);
        } finally {accept();}
        const promoted = remoteSessionPath(project.path, 'codex', 'new-native');
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(promoted));
        expect(shell.tabs.current).toBe(draftTab); expect(shell.editor).toBe(draftEditor);
        expect(mount.querySelector('.llm-input__textarea')).toBe(textarea); expect(mount.querySelector('#llm-ui-history')).toBe(history);
        expect(textarea.value).toBe('Next remote message'); expect(textarea.selectionStart).toBe(4);
        expect(document.activeElement).toBe(textarea); expect(draftTab.conversationId).toBe(uuid);
        expect(mount.querySelector('.llm-draft-scope')).toBeNull();
        expect(peer.create).toHaveBeenCalledOnce(); expect(peer.turn).toHaveBeenCalledWith('codex','new-native','remote task',expect.anything());
        expect((await runtime.sessionRepository.list()).length).toBe(before);
        expect((await runtime.projects.drafts.open(project.project.id, folder)).id).not.toBe(uuid);
        await workbench.openResource(initialScope); await shell.tabs.close(promoted, false);
        await workbench.openResource(promoted);
        expect(shell.tabs.current.conversationId).toBe(uuid);
        expect(activePanel().querySelector<HTMLElement>('.session-editor-mount')!.dataset.conversationId).toBe(uuid);
        expect(activePanel().querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('Next remote message');
        vi.mocked(peer.create).mockImplementationOnce(async () => {const session={...native,id:'second-native'};sessionList.push(session);return {session};});
        await controls.send(remoteId,'another task');expect(peer.create).toHaveBeenCalledTimes(2);
        expect(peer.turn).toHaveBeenLastCalledWith('codex','second-native','another task',expect.anything());
        const menu = async () => {
            await workbench.openResource('/'); await ui.showItemMenu(new MouseEvent('contextmenu'), remotePath);
            const host = document.querySelector<HTMLElement>('.vfs-context-menu')!;
            expect(host.querySelector('[data-action="delete"]')).toBeNull(); expect(host.querySelector('[data-action="moveTo"]')).toBeNull();
            expect(host.querySelector('[data-action="copyTo"]')).toBeNull(); expect(host.querySelector('[data-action="unmount-project"]')?.getAttribute('aria-label')).toBe(t('remote.unmountProject'));
            return host;
        };
        const remountAs = async (access: 'ro' | 'rw') => {
            (await menu()).querySelector<HTMLButtonElement>('[data-action="remount-project"]')!.click();
            await vi.waitFor(() => expect(document.querySelector('dialog select')).not.toBeNull());
            document.querySelector<HTMLSelectElement>('dialog select')!.value = access;
            document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
            await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
            expect(remote.list(project.project.id)[0].access).toBe(access); expect(workbench.getActiveResourceId()).toBe('/');
        };
        await remountAs('ro'); await workbench.openResource(profilePath, {reload: true});
        expect(activePanel().querySelector<HTMLButtonElement>('[data-action="create-session"]')!.disabled).toBe(true);
        expect(activePanel().querySelector(`[data-resource-id="${profilePath}/@new"]`)).toBeNull();
        await vi.waitFor(() => expect(sidebarCreate.disabled).toBe(true));
        await workbench.openResource(nativePath);
        expect(activePanel().querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
        await remountAs('rw'); await workbench.openResource(nativePath);
        expect(activePanel().querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false);
        (await menu()).querySelector<HTMLButtonElement>('[data-action="unmount-project"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain('远端目录'));
        document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
        await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
        expect(remote.list(project.project.id)).toEqual([]); await expect(runtime.projects.get(project.project.id)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await fileSource.fs.driver.exists('/project')).toBe(true); expect(peer.turn).toHaveBeenCalledTimes(2);
    } finally {await workbench.destroy();await runtime.dispose();await fileSource.dispose();fetch.mockRestore();sidebar.remove();main.remove();}
});
