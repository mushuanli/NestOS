// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { ProjectRemoteMountService } from '@itookit/app-core';
import { PI_AGENT_EXTENSION } from '@itookit/app-core';
import { PiAgentMCPControls } from '../src/toolbox/pi-agent-controls';
import { MCPConfigurationControlsRegistry } from '../src/toolbox/mcp-controls';

it('renders verified pi-agent controls without performing network discovery',async () => {
    const restore = vi.fn(), setMCPCredential = vi.fn(() => restore), discoverMCP = vi.fn(async () => ({version:1 as const,
        httpEndpoint:'https://office.test/agent',serverId:'office',fileProtocol:'fs-agent-http-v1' as const,harness:true}));
    const controls = new PiAgentMCPControls({setMCPCredential,discoverMCP} as unknown as ProjectRemoteMountService);
    const container = document.createElement('div');
    const server = {id:'office',name:'Any display name',transport:'http' as const,endpoint:'https://office.test/agent/mcp',apiKey:'test-api-key-at-least-24-bytes',
        extensions:{[PI_AGENT_EXTENSION]:{version:1,mcpEndpoint:'https://office.test/agent/mcp',httpEndpoint:'https://office.test/agent',fileProtocol:'fs-agent-http-v1',serverId:'office',harness:false}}};
    controls.render(container,server);
    expect(container.querySelector('input')).toBeNull();
    const draft = controls.read(server);
    expect(draft.auth).toBeUndefined();
    expect(container.textContent).toContain('API Key');expect(discoverMCP).not.toHaveBeenCalled();
    expect(setMCPCredential).not.toHaveBeenCalled();controls.dispose();
});
it('does not classify an ordinary MCP by its display name or API Key',async () => {
    const discoverMCP = vi.fn(), controls = new PiAgentMCPControls({discoverMCP} as unknown as ProjectRemoteMountService);
    const container = document.createElement('div'), server = {id:'plain',name:'pi-agent',transport:'http' as const,endpoint:'https://ordinary.test/mcp',apiKey:'ordinary-key'};
    controls.render(container,server); const draft = controls.read(server);
    expect(draft.extensions?.[PI_AGENT_EXTENSION]).toBeUndefined();
    expect(draft).toEqual(server);
    expect(discoverMCP).not.toHaveBeenCalled(); controls.dispose();
});

it('routes registered views only to matching extensions and preserves ordinary MCP authentication',() => {
    const render = vi.fn(), read = vi.fn(server => server), dispose = vi.fn();
    const registry = new MCPConfigurationControlsRegistry().register(PI_AGENT_EXTENSION,{render,read,dispose});
    const parent = document.createElement('div');
    const plain = {id:'ordinary',name:'Ordinary',transport:'http' as const,apiKey:'key',headers:{Authorization:'custom'}};
    registry.render(parent,plain);expect(registry.read(plain)).toBe(plain);
    expect(render).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
    const verified = {...plain,extensions:{[PI_AGENT_EXTENSION]:{version:1}}};
    registry.render(parent,verified);registry.read(verified);
    expect(render).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();
    registry.dispose();expect(dispose).toHaveBeenCalledOnce();
});
