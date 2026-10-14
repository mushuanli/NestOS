import { expect, it, vi } from 'vitest';
import { listRemoteHarnessAgents } from '../src/projects/remote-agent-catalog';
import { ToolboxInventory } from '../src/configuration/toolbox-catalog';
import { createFileSystemView, createFileSystemSource, MemoryBackend } from '@itookit/vfs-core';
import type { ProjectRemoteMountService } from '../src/projects/remote-mounts';
it('advertises only configured project harnesses from verified pi-agent connections', async () => {
    const close=vi.fn(async () => {}),harness=vi.fn(() => ({profiles:async () => ({profiles:[
        {id:'c',kind:'codex',projectRuntime:true,workspaces:[],capabilities:{}},
        {id:'legacy',kind:'codex',projectRuntime:false,workspaces:[],capabilities:{}}
    ]}),close}));
    const remote={connections:()=>[{id:'one',name:'Server',projects:true},{id:'generic-mcp',name:'Other'}],harness} as unknown as ProjectRemoteMountService;
    const agents=await listRemoteHarnessAgents(remote);expect(agents).toHaveLength(1);expect(agents[0].profile.kind).toBe('codex');
    expect(harness).toHaveBeenCalledExactlyOnceWith('one');expect(close).toHaveBeenCalledOnce();
});
it('mounts read-only remote agent metadata alongside writable local definitions', async () => {
    const agent={id:'remote:["server","codex"]',name:'Server · Codex',description:'Remote',source:'Server',icon:'remote',connectionId:'server',profile:{id:'codex',kind:'codex',projectRuntime:true,workspaces:[],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}}};
    const inventory=new ToolboxInventory(async () => [],{listTools:()=>[],getToolDefinitions:()=>[]},undefined,undefined,async () => [agent]);
    await inventory.init();const local=await createFileSystemSource({backend:new MemoryBackend(),viewId:'local',access:'rw'});
    const view=createFileSystemView({viewId:'agents',mounts:[{mountId:'local',at:'/',fs:local.fs,access:'rw'},{mountId:'remote',at:'/@remote',fs:inventory.remoteAgentSource,access:'ro'}]});
    try {
        const nodes=await view.driver.getChildren('/@remote');expect(nodes).toHaveLength(1);expect(nodes[0].metadata).toMatchObject({remoteHarnessAgent:true,_readOnly:true});
        await expect(view.driver.writeContent(nodes[0].path,'{}')).rejects.toMatchObject({code:'EROFS'});
        await view.driver.createFile({parentPath:'/',name:'local.agent',content:'local'});expect(await local.fs.driver.exists('/local.agent')).toBe(true);
    } finally {await view.dispose();await local.dispose();await inventory.dispose();}
});
