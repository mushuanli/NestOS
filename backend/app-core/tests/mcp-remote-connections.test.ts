import { expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { MCPRemoteConnections, PI_AGENT_EXTENSION, remoteMCPConnection } from '../src/projects/mcp-remote-connections';
import { RemoteMountStore } from '../src/projects/remote-mount-store';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';

const server = {id:'office',name:'Office',transport:'http' as const,endpoint:'https://office.test/mcp',
    auth:{type:'basic' as const,username:'alice',credentialRef:'ref'},
    extensions:{[PI_AGENT_EXTENSION]:{version:1,mcpEndpoint:'https://office.test/mcp',httpEndpoint:'https://office.test',
        fileProtocol:'fs-agent-http-v1',serverId:'office-node',harness:true}}};
it('only projects verified pi-agent HTTP configurations and permits multiple independent configurations',async () => {
    const servers = [server,{...server,id:'second',name:'Second',auth:{...server.auth,credentialRef:'second'}},
        {id:'plain',name:'pi-agent',transport:'http' as const,endpoint:'https://plain.test/mcp'}];
    const registry = new MCPRemoteConnections({getMCPServers:async () => servers,saveMCPServer:vi.fn(),deleteMCPServer:vi.fn()},
        {setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()});
    await registry.refresh(); expect(registry.list().map(item => item.id)).toEqual(['office','second']);
    expect(remoteMCPConnection({...server,endpoint:'https://other.test/mcp'})).toBeUndefined();
    expect(remoteMCPConnection({...server,extensions:{[PI_AGENT_EXTENSION]:{requested:true}}})).toBeUndefined();
});
it('moves legacy connections and passwords out of the mount catalog without changing project references',async () => {
    const runtime = await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web'});
    const provider = {setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()};
    const root = await runtime.vfs.openFileSystem('/'), store = new RemoteMountStore(root);
    const connection = {id:'legacy',name:'Legacy',endpoint:'https://legacy.test',username:'alice',credentialRef:'legacy-secret'};
    const mount = {mountId:'grant',at:'/',root:'/project',alias:'docs',access:'ro' as const,connectionId:'legacy',
        endpoint:connection.endpoint,username:connection.username,credentialRef:connection.credentialRef};
    await store.load(); await store.save({version:1,revision:1,connections:[connection],projects:{project:[mount]}},
        {id:'legacy',password:'private-password'});
    const registry = new MCPRemoteConnections(runtime.agentService,provider);
    const remote = new ProjectRemoteMountService(root,provider,async () => {},async () => {},registry);
    try {
        await remote.init();
        expect(remote.connection('legacy')).toEqual(connection);
        expect(remote.list('project')[0]).toMatchObject({mountId:'grant',connectionId:'legacy',root:'/project'});
        expect(provider.setCredential).toHaveBeenCalledWith('legacy-secret','private-password');
        const mcp = (await runtime.agentService.getMCPServers()).find(item => item.id === 'legacy');
        expect(mcp?.endpoint).toBe('https://legacy.test/mcp'); expect(JSON.stringify(mcp)).not.toContain('private-password');
        expect(await root.meta.seq!.getEntry('/etc/fs/remote/legacy.seq','config')).toBeNull();
        expect(await root.meta.seq!.getEntry('/etc/fs/remote/legacy.seq','password')).toBeNull();
        await remote.init(); expect((await runtime.agentService.getMCPServers()).filter(item => item.id === 'legacy')).toHaveLength(1);
    } finally { await remote.dispose(); await runtime.dispose(); }
});

it('restores a verified API Key connection from the MCP catalog without a username',async () => {
    const apiKey = 'fixed-api-key-at-least-24-bytes';
    const bearer = {...server,auth:undefined,apiKey};
    const provider = {setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()};
    const registry = new MCPRemoteConnections({getMCPServers:async () => [bearer],saveMCPServer:vi.fn(),deleteMCPServer:vi.fn()},provider);
    await registry.refresh();
    expect(registry.list()[0]).toMatchObject({id:'office',credentialRef:'mcp-office',endpoint:'https://office.test'});
    expect(registry.list()[0].username).toBeUndefined();
    expect(provider.setCredential).toHaveBeenCalledWith('mcp-office',apiKey);
    expect(JSON.stringify(registry.list())).not.toContain(apiKey);
    expect(remoteMCPConnection({...bearer,extensions:undefined})).toBeUndefined();
});

it('verifies discovered pi-agent tools through the generic connection and reuses verification when saving or renaming',async () => {
    const provider = {setCredential:vi.fn(() => vi.fn()),dispose:vi.fn(),open:vi.fn(),discover:vi.fn(async () => ({
        version:1 as const,httpEndpoint:'https://office.test',serverId:'office',fileProtocol:'fs-agent-http-v1' as const,
        harness:true,projects:true,projectProtocol:'fs-agent-project-v1',
    }))};
    const runtime = await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web',remoteSourceProvider:provider});
    const remote = runtime.projects.remoteMounts!;
    const descriptor = await provider.discover(), methods: string[] = [];
    const fetch = vi.fn(async (_url: unknown,init?: RequestInit) => {
        if (init?.method !== 'POST') return new Response(null,{status:405});
        const message = JSON.parse(String(init.body));methods.push(message.method);
        const result = message.method === 'server/discover' ? {supportedVersions:['2026-07-28'],capabilities:{tools:{}}}
            : message.method === 'tools/list' ? {tools:[{name:'piagent_capabilities',inputSchema:{type:'object'}}]}
            : {structuredContent:descriptor,content:[],isError:false};
        return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{resultType:'complete',ttlMs:0,cacheScope:'private',...result}}),
            {headers:{'content-type':'application/json'}});
    });
    vi.stubGlobal('fetch',fetch);
    provider.discover.mockClear();
    try {
        const draft = {id:'office',name:'Office',transport:'http' as const,endpoint:'https://office.test/mcp',
            apiKey:'fixed-api-key-at-least-24-bytes',tools:[{name:'piagent_capabilities'}]};
        const discovery = await runtime.agentService.testMCPServer(draft);
        await runtime.agentService.saveMCPServer({...draft,...discovery});
        await runtime.agentService.saveMCPServer({...draft,...discovery,name:'New label'});
        expect(remote.connection('office')).toMatchObject({credentialRef:'mcp-office',projects:true});
        expect(remote.connection('office').username).toBeUndefined();
        expect(methods).toEqual(['server/discover','tools/list','tools/call']);
        expect(provider.discover).not.toHaveBeenCalled();
    } finally {await runtime.dispose();vi.unstubAllGlobals();}
});
it('reads old fs-agent extensions without changing project or credential identities',async()=>{
    const legacy={...server,extensions:{'itookit/fs-agent':server.extensions[PI_AGENT_EXTENSION]}};
    expect(remoteMCPConnection(legacy)).toEqual(remoteMCPConnection(server));
    const registry=new MCPRemoteConnections({getMCPServers:async()=>[legacy],saveMCPServer:vi.fn(),deleteMCPServer:vi.fn()},
        {setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()});
    await registry.refresh();expect(registry.list()[0]).toMatchObject({id:'office',credentialRef:'ref'});
});

it('repairs a referenced MCP whose saved capability extension was lost without probing unrelated servers',async()=>{
    const bearer={...server,auth:undefined,apiKey:'test-key',extensions:undefined};
    let saved=[bearer];const testMCPServer=vi.fn(async()=>({tools:[],resources:[],prompts:[],extensions:server.extensions}));
    const saveMCPServer=vi.fn(async value=>{saved=[value];});
    const registry=new MCPRemoteConnections({getMCPServers:async()=>saved,saveMCPServer,testMCPServer,deleteMCPServer:vi.fn()},
        {setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()});
    await registry.refresh();expect(registry.list()).toEqual([]);
    await registry.ensure('office');expect(registry.list()[0]).toMatchObject({id:'office',credentialRef:'mcp-office'});
    await registry.ensure('office');expect(testMCPServer).toHaveBeenCalledOnce();expect(saveMCPServer).toHaveBeenCalledOnce();
});
it('ignores an older catalog refresh that finishes after a newer configuration update',async()=>{
    let finish!:(value:typeof server[])=>void;
    const getMCPServers=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue([]);
    const registry=new MCPRemoteConnections({getMCPServers,saveMCPServer:vi.fn(),deleteMCPServer:vi.fn()},
        {setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn()});
    const older=registry.refresh();await registry.refresh();finish([server]);await older;expect(registry.list()).toEqual([]);
});
