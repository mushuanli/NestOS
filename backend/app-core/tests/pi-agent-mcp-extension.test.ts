import {expect,it,vi} from 'vitest';
import {createPiAgentMCPExtension} from '../src/projects/pi-agent-mcp-extension';
import {PI_AGENT_EXTENSION} from '../src/projects/mcp-remote-connections';
const server={id:'personal',name:'Personal',transport:'http' as const,endpoint:'https://personal.test/mcp',apiKey:'key'};
const descriptor={version:1,fileProtocol:'fs-agent-http-v1',serverId:'node',httpEndpoint:'./',harness:true,projects:true,projectProtocol:'fs-agent-project-v1'};
const discovery={tools:[],resources:[],prompts:[],metadata:{[PI_AGENT_EXTENSION]:descriptor}};
it('uses the namespaced standard discovery descriptor without an extra capability call',async()=>{
    const extension=createPiAgentMCPExtension(),callTool=vi.fn();expect(extension.matches(server,discovery)).toBe(true);
    expect(await extension.discover({server,discovery,callTool})).toMatchObject({httpEndpoint:'https://personal.test',mcpEndpoint:server.endpoint,serverId:'node'});
    expect(callTool).not.toHaveBeenCalled();
});
it.each(['piagent_capabilities','fsagent_capabilities'])('calls only the advertised %s tool on an older pi-agent',async name=>{
    const extension=createPiAgentMCPExtension(),callTool=vi.fn(async()=>({structuredContent:descriptor}));
    const old={tools:[{name,inputSchema:{}}],resources:[],prompts:[]};
    expect(await extension.discover({server,discovery:old,callTool})).toMatchObject({serverId:'node'});
    expect(callTool).toHaveBeenCalledExactlyOnceWith(name,{});
});
it('does not classify ordinary MCP servers by their display name or credential',()=>{
    expect(createPiAgentMCPExtension().matches({...server,name:'pi-agent'},{tools:[],resources:[],prompts:[]})).toBe(false);
});
it.each([{...descriptor,httpEndpoint:'https://other.test'}, {...descriptor,httpEndpoint:'https://user:secret@personal.test'}, {...descriptor,version:9}])
('rejects invalid advertised descriptors without trying another discovery tool',async value=>{
    const callTool=vi.fn();await expect(createPiAgentMCPExtension().discover({server,discovery:{...discovery,metadata:{[PI_AGENT_EXTENSION]:value}},callTool})).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
});
