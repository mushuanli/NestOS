// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { ProjectRemoteMountService } from '@itookit/app-core';
import { MINDOS_NODE_EXTENSION } from '@itookit/app-core';
import { MindOSNodeMCPControls } from '../src/toolbox/mindos-node-controls';
import { MCPConfigurationControlsRegistry } from '../src/toolbox/mcp-controls';
import type { ProjectService } from '@itookit/app-contracts/services';

it('renders verified mindos-node controls without performing network discovery',async () => {
    const restore = vi.fn(), setMCPCredential = vi.fn(() => restore), discoverMCP = vi.fn(async () => ({version:1 as const,
        httpEndpoint:'https://office.test/agent',serverId:'office',fileProtocol:'fs-agent-http-v1' as const,harness:true}));
    const controls = new MindOSNodeMCPControls({setMCPCredential,discoverMCP} as unknown as ProjectRemoteMountService);
    const container = document.createElement('div');
    const server = {id:'office',name:'Any display name',transport:'http' as const,endpoint:'https://office.test/agent/mcp',apiKey:'test-api-key-at-least-24-bytes',
        extensions:{[MINDOS_NODE_EXTENSION]:{version:1,mcpEndpoint:'https://office.test/agent/mcp',httpEndpoint:'https://office.test/agent',fileProtocol:'fs-agent-http-v1',serverId:'office',harness:false}}};
    controls.render(container,server);
    expect(container.querySelector('input')).toBeNull();
    const draft = controls.read(server);
    expect(draft.auth).toBeUndefined();
    expect(container.textContent).toContain('API Key');expect(discoverMCP).not.toHaveBeenCalled();
    expect(setMCPCredential).not.toHaveBeenCalled();controls.dispose();
});
it('does not classify an ordinary MCP by its display name or API Key',async () => {
    const discoverMCP = vi.fn(), controls = new MindOSNodeMCPControls({discoverMCP} as unknown as ProjectRemoteMountService);
    const container = document.createElement('div'), server = {id:'plain',name:'mindos-node',transport:'http' as const,endpoint:'https://ordinary.test/mcp',apiKey:'ordinary-key'};
    controls.render(container,server); const draft = controls.read(server);
    expect(draft.extensions?.[MINDOS_NODE_EXTENSION]).toBeUndefined();
    expect(draft).toEqual(server);
    expect(discoverMCP).not.toHaveBeenCalled(); controls.dispose();
});

it('routes registered views only to matching extensions and preserves ordinary MCP authentication',() => {
    const render = vi.fn(), read = vi.fn(server => server), dispose = vi.fn();
    const registry = new MCPConfigurationControlsRegistry().register(MINDOS_NODE_EXTENSION,{render,read,dispose});
    const parent = document.createElement('div');
    const plain = {id:'ordinary',name:'Ordinary',transport:'http' as const,apiKey:'key',headers:{Authorization:'custom'}};
    registry.render(parent,plain);expect(registry.read(plain)).toBe(plain);
    expect(render).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
    const verified = {...plain,extensions:{[MINDOS_NODE_EXTENSION]:{version:1}}};
    registry.render(parent,verified);registry.read(verified);
    expect(render).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();
    registry.dispose();expect(dispose).toHaveBeenCalledOnce();
});

it('projects mount permissions from the project service and releases its subscription', async () => {
    let changed!: () => void, access: 'ro' | 'rw' = 'ro';
    const stop = vi.fn(), remote = {onChange: (listener: () => void) => {changed = listener; return stop;}, status: () => 'online',
        list: () => [{connectionId: 'node', mountId: 'mount', alias: 'docs', root: '/project', at: '/', get access() {return access;}}]};
    const projects = {list: async () => [{name: 'Project', project: {id: 'p'}}]} as unknown as ProjectService;
    const controls = new MindOSNodeMCPControls(remote as never, projects), host = document.createElement('div');
    const server = {id: 'node', name: 'Node', transport: 'http' as const, endpoint: 'https://files.test/mcp',
        extensions: {[MINDOS_NODE_EXTENSION]: {version: 1, mcpEndpoint: 'https://files.test/mcp', httpEndpoint: 'https://files.test', fileProtocol: 'fs-agent-http-v1', harness: false}}};
    controls.render(host, server); await vi.waitFor(() => expect(host.textContent).toContain('只读'));
    expect(host.textContent).toContain('客户端授权'); expect(host.textContent).toContain('/docs/project');
    access = 'rw'; changed(); await vi.waitFor(() => expect(host.textContent).toContain('读写'));
    controls.dispose(); expect(stop).toHaveBeenCalledOnce();
});
