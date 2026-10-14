import {afterEach,expect,it,vi} from 'vitest';
import type {MCPDiscovery,MCPServer} from '@itookit/tools/mcp-contracts';
import type {MCPConfigurationExtension} from '../../src/llm-management/contracts/mcp-transport';
import {MCPManager} from '../../src/llm-management/device/mcp-manager';
import {MCPServerConnection} from '../../src/llm-management/skills/mcp-client';

afterEach(()=>vi.restoreAllMocks());
function setup() {
    const active = new WeakSet<MCPServerConnection>();
    const connect = vi.spyOn(MCPServerConnection.prototype,'connect').mockImplementation(async function(this:MCPServerConnection){active.add(this);});
    vi.spyOn(MCPServerConnection.prototype,'isConnected').mockImplementation(function(this:MCPServerConnection){return active.has(this);});
    vi.spyOn(MCPServerConnection.prototype,'disconnect').mockImplementation(async function(this:MCPServerConnection){active.delete(this);});
    const discovery:MCPDiscovery = {tools:[{name:'personal_capabilities',inputSchema:{}}],resources:[],prompts:[]};
    const discover = vi.spyOn(MCPServerConnection.prototype,'discover').mockResolvedValue(discovery);
    const call = vi.spyOn(MCPServerConnection.prototype,'callTool').mockResolvedValue({structuredContent:{version:1}});
    const plugin:MCPConfigurationExtension = {key:'test/personal',matches:(_server,value)=>value.tools.some(tool=>tool.name==='personal_capabilities'),
        discover:vi.fn(async context=>((await context.callTool('personal_capabilities',{})) as {structuredContent:unknown}).structuredContent)};
    const helpers = {engineUpsert:vi.fn(),getFileSystem:()=>({driver:{resolvePath:async()=>undefined}})};
    const manager = new MCPManager(helpers as never,{createDeviceNode:vi.fn(),removeDeviceNode:vi.fn()} as never,()=>{}, {extensions:[plugin]});
    const server:MCPServer = {id:'personal',name:'Personal',transport:'http',endpoint:'https://personal.test/mcp',apiKey:'one'};
    return {manager,server,connect,discover,call,plugin,helpers};
}
it('reuses one authenticated connection and one extension result across testing, saving and presentation edits',async()=>{
    const f=setup();const discovered=await f.manager.testMCPServer(f.server);
    await f.manager.saveMCPServer({...f.server,...discovered});
    await f.manager.saveMCPServer({...f.manager.getServers()[0],name:'Renamed',description:'New description'});
    expect(f.manager.getServers()[0].extensions).toEqual({'test/personal':{version:1}});
    expect(f.connect).toHaveBeenCalledOnce();expect(f.discover).toHaveBeenCalledOnce();expect(f.call).toHaveBeenCalledOnce();
    await f.manager.disconnectAll();
});
it('does not run unmatched extensions or alter ordinary MCP metadata',async()=>{
    const f=setup();f.discover.mockResolvedValue({tools:[],resources:[],prompts:[]});
    const discovered=await f.manager.testMCPServer(f.server);
    await f.manager.saveMCPServer({...f.server,...discovered,extensions:{'other/feature':{enabled:true}}});
    expect(f.call).not.toHaveBeenCalled();expect(f.plugin.discover).not.toHaveBeenCalled();
    expect(f.manager.getServers()[0].extensions).toEqual({'other/feature':{enabled:true}});await f.manager.disconnectAll();
});
it.each(['endpoint','apiKey','headers'] as const)('invalidates extension verification when %s changes',async key=>{
    const f=setup();const discovered=await f.manager.testMCPServer(f.server);await f.manager.saveMCPServer({...f.server,...discovered});
    await f.manager.saveMCPServer({...f.manager.getServers()[0],[key]:key==='headers'?{'x-tenant':'two'}:'two'});
    expect(f.call).toHaveBeenCalledTimes(2);expect(f.discover).toHaveBeenCalledTimes(2);await f.manager.disconnectAll();
});
it('removes an old extension when a new explicit discovery no longer advertises it',async()=>{
    const f=setup();await f.manager.saveMCPServer({...f.server,...await f.manager.testMCPServer(f.server)});
    f.discover.mockResolvedValue({tools:[],resources:[],prompts:[]});
    const previous=f.manager.getServers()[0],discovered=await f.manager.testMCPServer(previous);
    await f.manager.saveMCPServer({...previous,...discovered,extensions:previous.extensions});
    expect(f.manager.getServers()[0].extensions).toEqual({});expect(f.call).toHaveBeenCalledOnce();await f.manager.disconnectAll();
});
it('never persists a configuration when extension verification fails',async()=>{
    const f=setup();await f.manager.saveMCPServer({...f.server,...await f.manager.testMCPServer(f.server)});
    const before=f.manager.getServers()[0];f.helpers.engineUpsert.mockClear();f.call.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(f.manager.saveMCPServer({...before,apiKey:'wrong'})).rejects.toThrow('Unauthorized');
    expect(f.manager.getServers()[0]).toEqual(before);expect(f.helpers.engineUpsert).not.toHaveBeenCalled();await f.manager.disconnectAll();
});
it('revalidates an existing extension even when the saved tool list is removed',async()=>{
    const f=setup();await f.manager.saveMCPServer({...f.server,...await f.manager.testMCPServer(f.server)});
    await f.manager.saveMCPServer({...f.manager.getServers()[0],apiKey:'changed',tools:undefined});
    expect(f.discover).toHaveBeenCalledTimes(2);expect(f.call).toHaveBeenCalledTimes(2);await f.manager.disconnectAll();
});
it('verifies imported extension claims instead of trusting their serialized descriptor',async()=>{
    const f=setup();f.call.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(f.manager.saveMCPServer({...f.server,extensions:{'test/personal':{version:1}}})).rejects.toThrow('Unauthorized');
    expect(f.helpers.engineUpsert).not.toHaveBeenCalled();await f.manager.disconnectAll();
});
it('does not carry verification across deletion and recreation of a server ID',async()=>{
    const f=setup();await f.manager.saveMCPServer({...f.server,...await f.manager.testMCPServer(f.server)});
    await f.manager.deleteMCPServer(f.server.id);await f.manager.saveMCPServer({...f.server,tools:[{name:'personal_capabilities'}]});
    expect(f.call).toHaveBeenCalledTimes(2);await f.manager.disconnectAll();
});
