// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ProjectNavigation} from '../src/projects/ProjectNavigation';
import {showProjectSettings} from '../src/projects/project-settings';
const cleanup: Array<() => void> = [];
beforeEach(() => {
    for (const method of ['showModal','close']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,method);
        Object.defineProperty(HTMLDialogElement.prototype,method,{configurable:true,value:vi.fn()});
        cleanup.push(() => descriptor ? Object.defineProperty(HTMLDialogElement.prototype,method,descriptor) : delete (HTMLDialogElement.prototype as unknown as Record<string,unknown>)[method]);
    }
});
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close(); document.body.replaceChildren();});
function fixture(remote: boolean) {
    let project = {path:'/x1',name:'x1',displayName:remote?'r1:x1':'x1',parentPath:null,updatedAt:1,protected:!remote,
        project:{id:remote?'x1':'local',directory:remote?'project:x1':'/home/admin/projects/local',source:{kind:remote?'remote':'local'}}};
    const id = project.project.id, executionSettings = vi.fn(async () => ({project:{id:'node-x1',revision:3},execution:{profile:null,variables:{}},profiles:[]}));
    const setExecution = vi.fn(async () => {}), localExecutionSettings = vi.fn(async () => ({revision:2,variables:{KEY:'old'}})), setLocalExecution = vi.fn(async () => {});
    const personal = vi.fn(() => {throw new Error('Must not read the reserved project');});
    const projects = {get:vi.fn(async () => project),personal,localExecutionSettings,setLocalExecution,
        renameProject:vi.fn(async (_from:string,to:string) => {project = {...project,path:to,name:to.slice(1)};}),
        remoteMounts:{executionSettings,setExecution,projectOffline:() => false,list:() => remote?[{at:'/',connectionId:'r1'}]:[],onChange:() => () => {}},
        navigation:async () => ({project,projects:[project],path:project.path,pendingDeletions:0,offlineProjectIds:[],loadPaths:[]})};
    return {projects,id,executionSettings,setExecution,localExecutionSettings,setLocalExecution,personal};
}
it('opens the selected remote project from both header and overflow without reading local defaults',async () => {
    const f = fixture(true), report = vi.fn();
    const navigation = new ProjectNavigation(f.projects as never,() => undefined,{report} as never); cleanup.push(() => navigation.destroy());
    document.body.append(navigation.header); await navigation.sync('/x1');
    const buttons = navigation.header.querySelectorAll<HTMLButtonElement>('[data-project-action="settings"]'); expect(buttons.length).toBe(2);
    for (const button of buttons) {
        button.click(); await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
        expect(document.querySelector('dialog')!.getAttribute('aria-label')).toContain('r1:x1');
        expect(document.querySelector<HTMLInputElement>('input[readonly]')!.value).toBe('x1');
        document.querySelector<HTMLButtonElement>('dialog button[type="button"]')!.click();
        await vi.waitFor(() => expect(button.disabled).toBe(false));
    }
    expect(f.executionSettings).toHaveBeenCalledTimes(2); expect(f.executionSettings).toHaveBeenCalledWith('x1',expect.any(Object));
    expect(f.personal).not.toHaveBeenCalled(); expect(f.localExecutionSettings).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
});
it('saves only the selected local environment and name while leaving the ID read-only',async () => {
    const f = fixture(false), controller = new AbortController(), changed = vi.fn(async () => {});
    cleanup.push(() => controller.abort());
    const pending = showProjectSettings(f.projects as never,'local',controller.signal,changed);
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('input[readonly]')!.value).toBe('local');
    document.querySelector<HTMLInputElement>('#project-settings-name')!.value = 'My local';
    document.querySelector('textarea')!.value = 'GIT_AUTHOR_NAME=Rain Li';
    document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); await pending;
    expect(f.setLocalExecution).toHaveBeenCalledWith('local',2,{GIT_AUTHOR_NAME:'Rain Li'});
    expect(f.projects.renameProject).toHaveBeenCalledWith('/x1','/My local'); expect(f.setExecution).not.toHaveBeenCalled();
    expect(changed.mock.calls[0]?.[1].project.id).toBe('local'); expect(f.personal).not.toHaveBeenCalled();
});

it('keeps the selected remote identity visible when an old node lacks environment support',async () => {
    const f = fixture(true), controller = new AbortController(); cleanup.push(() => controller.abort());
    f.executionSettings.mockRejectedValueOnce({code:'ECAPABILITY'});
    const pending = showProjectSettings(f.projects as never,'x1',controller.signal,async () => {});
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    expect(document.querySelector('dialog')!.getAttribute('aria-label')).toContain('r1:x1');
    expect(document.querySelector('dialog')!.textContent).toContain('ECAPABILITY');
    expect(f.personal).not.toHaveBeenCalled(); expect(f.localExecutionSettings).not.toHaveBeenCalled();
    controller.abort(); await pending;
});
