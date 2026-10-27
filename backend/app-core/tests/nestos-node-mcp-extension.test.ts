import {expect,it,vi} from 'vitest';
import {createNestOSNodeMCPExtension} from '../src/projects/nestos-node-mcp-extension';
import {NESTOS_NODE_EXTENSION} from '../src/projects/mcp-remote-connections';
const server={id:'personal',name:'Personal',transport:'http' as const,endpoint:'https://personal.test/mcp',apiKey:'key'};
const descriptor={version:1,fileProtocol:'fs-agent-http-v1',serverId:'node',httpEndpoint:'./',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'};
const discovery={tools:[],resources:[],prompts:[],metadata:{[NESTOS_NODE_EXTENSION]:descriptor}};
it.each(['itookit/nestos-node', NESTOS_NODE_EXTENSION])('uses %s discovery without an extra capability call',async key=>{
    const discovery={tools:[],resources:[],prompts:[],metadata:{[key]:descriptor}};
    const extension=createNestOSNodeMCPExtension(),callTool=vi.fn();expect(extension.matches(server,discovery)).toBe(true);
    expect(await extension.discover({server,discovery,callTool})).toMatchObject({httpEndpoint:'https://personal.test',mcpEndpoint:server.endpoint,serverId:'node'});
    expect(callTool).not.toHaveBeenCalled();
});
it.each(['nestos_node_capabilities','piagent_capabilities','fsagent_capabilities'])('calls only the advertised %s tool',async name=>{
    const extension=createNestOSNodeMCPExtension(),callTool=vi.fn(async()=>({structuredContent:descriptor}));
    const old={tools:[{name,inputSchema:{}}],resources:[],prompts:[]};
    expect(await extension.discover({server,discovery:old,callTool})).toMatchObject({serverId:'node'});
    expect(callTool).toHaveBeenCalledExactlyOnceWith(name,{});
});
it('does not classify ordinary MCP servers by their display name or credential',()=>{
    expect(createNestOSNodeMCPExtension().matches({...server,name:'nestos-node'},{tools:[],resources:[],prompts:[]})).toBe(false);
});
it.each([{...descriptor,httpEndpoint:'https://other.test'}, {...descriptor,httpEndpoint:'https://user:secret@personal.test'}, {...descriptor,version:9}])
('rejects invalid advertised descriptors without trying another discovery tool',async value=>{
    const callTool=vi.fn();await expect(createNestOSNodeMCPExtension().discover({server,discovery:{...discovery,metadata:{[NESTOS_NODE_EXTENSION]:value}},callTool})).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
});
