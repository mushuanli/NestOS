// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ModelConfigurationCommands, type ProjectService } from '@itookit/app-core';
import { ConfigurationDeletionDialog } from '../src/configuration/delete-dialog';

afterEach(() => { document.body.innerHTML = ''; });

function fixture() {
    const store = {getProviders:() => [],getConnections:async () => [],getMCPServers:async () => [{id:'office',name:'Office server'}],
        deleteProvider:vi.fn(),deleteConnection:vi.fn(),deleteMCPServer:vi.fn(),deleteSystemPrompt:vi.fn()};
    const commands = new ModelConfigurationCommands(store);
    let references = [{connectionId:'office',projectId:'p',mountId:'m',at:'/reference',revision:1}];
    const removeMCPReferences = vi.fn(async () => {references = [];});
    commands.mcpDeletion = {mcpReferences:() => references,removeMCPReferences};
    const projects = {list:async () => [{project:{id:'p'},name:'Work',displayName:'Office:Work'}]} as unknown as Pick<ProjectService,'list'>;
    const dialog = new ConfigurationDeletionDialog(commands,async () => {},async () => '',projects);
    return {store,commands,removeMCPReferences,dialog};
}

it('lists projects and refuses deletion until reference removal is explicitly selected',async () => {
    const {store,commands,removeMCPReferences,dialog} = fixture();
    const result = dialog.requestResult([{kind:'entity',entityType:'mcp',id:'office'}]);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    expect(document.body.textContent).toContain('Office:Work');
    expect(document.body.textContent).toContain('Office server');
    expect(document.body.textContent).not.toContain('(office)');
    expect(document.body.textContent).toContain('/reference');
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('请确认强制移除'));
    expect(store.deleteMCPServer).not.toHaveBeenCalled();
    document.querySelector<HTMLInputElement>('[id^="mcp-delete-"]')!.checked = true;
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    expect(await result).toBe('completed');
    expect(removeMCPReferences).toHaveBeenCalledOnce();
    expect(store.deleteMCPServer).toHaveBeenCalledWith('office');
    await commands.dispose();
});

it('uses project names and session titles for root project cleanup without exposing identifiers',async () => {
    const {commands,dialog} = fixture();
    commands.mcpDeletion = {mcpReferences:() => [{connectionId:'office',projectId:'p',mountId:'m',at:'/',revision:1}],
        inspectRemoteProjects:async () => [{id:'p',name:'Work',path:'/Work',localSessions:[{id:'session-internal-uuid',title:'Local notes'}]}],
        removeMCPReferences:vi.fn()};
    const result = dialog.requestResult([{kind:'entity',entityType:'mcp',id:'office'}]);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-cancel')).not.toBeNull());
    expect(document.body.textContent).toContain('删除本地远程项目');
    expect(document.body.textContent).toContain('Local notes');
    expect(document.body.textContent).not.toContain('session-internal-uuid');
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    expect(await result).toBe('cancelled');
    await commands.dispose();
});

it('cancelling retains the MCP configuration and all project references',async () => {
    const {store,commands,removeMCPReferences,dialog} = fixture();
    const result = dialog.requestResult([{kind:'entity',entityType:'mcp',id:'office'}]);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-cancel')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    expect(await result).toBe('cancelled');
    expect(store.deleteMCPServer).not.toHaveBeenCalled();
    expect(removeMCPReferences).not.toHaveBeenCalled();
    await commands.dispose();
});
