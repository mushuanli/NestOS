import {expect,it,vi} from 'vitest';
import {createMindOSNodeMCPExtension} from '../src/projects/mindos-node-mcp-extension';
import {MINDOS_NODE_EXTENSION} from '../src/projects/mcp-remote-connections';
const server={id:'personal',name:'Personal',transport:'http' as const,endpoint:'https://personal.test/mcp',apiKey:'key'};
const descriptor={version:1,fileProtocol:'fs-agent-http-v1',serverId:'node',httpEndpoint:'./',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'};
const discovery={tools:[],resources:[],prompts:[],metadata:{[MINDOS_NODE_EXTENSION]:descriptor}};
it.each(['itookit/mindos-node', MINDOS_NODE_EXTENSION])('uses %s discovery without an extra capability call',async key=>{
    const discovery={tools:[],resources:[],prompts:[],metadata:{[key]:descriptor}};
    const extension=createMindOSNodeMCPExtension(),callTool=vi.fn();expect(extension.matches(server,discovery)).toBe(true);
    expect(await extension.discover({server,discovery,callTool})).toMatchObject({httpEndpoint:'https://personal.test',mcpEndpoint:server.endpoint,serverId:'node'});
    expect(callTool).not.toHaveBeenCalled();
});
it.each(['mindos_node_capabilities','piagent_capabilities','fsagent_capabilities'])('calls only the advertised %s tool',async name=>{
    const extension=createMindOSNodeMCPExtension(),callTool=vi.fn(async()=>({structuredContent:descriptor}));
    const old={tools:[{name,inputSchema:{}}],resources:[],prompts:[]};
    expect(await extension.discover({server,discovery:old,callTool})).toMatchObject({serverId:'node'});
    expect(callTool).toHaveBeenCalledExactlyOnceWith(name,{});
});
it('does not classify ordinary MCP servers by their display name or credential',()=>{
    expect(createMindOSNodeMCPExtension().matches({...server,name:'mindos-node'},{tools:[],resources:[],prompts:[]})).toBe(false);
});
it.each([{...descriptor,httpEndpoint:'https://other.test'}, {...descriptor,httpEndpoint:'https://user:secret@personal.test'}, {...descriptor,version:9}])
('rejects invalid advertised descriptors without trying another discovery tool',async value=>{
    const callTool=vi.fn();await expect(createMindOSNodeMCPExtension().discover({server,discovery:{...discovery,metadata:{[MINDOS_NODE_EXTENSION]:value}},callTool})).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
});
