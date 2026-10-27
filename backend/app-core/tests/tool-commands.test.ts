import {expect, it, vi} from 'vitest';
import type {Kernel} from '@itookit/durable-kernel';
import {configuredToolCatalog, submitToolCommand, type ToolCommandPorts} from '../src/kernel/tool-commands';

it('submits one stable, approved tool task with only the selected tool grant', async () => {
    const task = {id: 'tool-task', createResource: vi.fn(async () => ({handle: {id: 'handle'}})), start: vi.fn()};
    const submit = vi.fn(async () => task);
    const kernel = {openSession: vi.fn(async () => ({submit}))} as unknown as Kernel;
    const prepareTools = vi.fn(), prepareSession = vi.fn(async () => true);
    const ports = {prepareSession, sessions: {get: async () => ({prepareTools,
        toolService: {getToolMeta: () => ({enabled: true, version: '2'})}})}} as unknown as ToolCommandPorts;
    await expect(submitToolCommand(kernel, ports, {sessionId: 's', requestId: 'stable-request',
        toolId: 'fixture.save', toolVersion: '2', args: {body: 'private'}})).resolves.toBe('tool-task');
    expect(prepareTools).toHaveBeenCalledWith(['fixture.save']);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({requestId: 'stable-request',
        input: {toolId: 'fixture.save', toolVersion: '2', args: {body: 'private'}, allowedToolIds: ['fixture.save'], approval: 'all'}}));
    expect(task.start).toHaveBeenCalledWith({signal: {type: 'capabilities', payload: {toolHandleId: 'handle'}}});
    prepareSession.mockResolvedValue(false);
    await expect(submitToolCommand(kernel, ports, {sessionId: 's', requestId: 'another',
        toolId: 'fixture.save', toolVersion: '2', args: {}})).rejects.toMatchObject({code: 'TOOL_COMMAND_SESSION_READ_ONLY'});
    expect(submit).toHaveBeenCalledTimes(1);
});

it('lists cached MCP schemas without exposing server transport or credentials', () => {
    const service = {getToolDefinitions: () => [], getToolMeta: () => undefined};
    const result = configuredToolCatalog(service, [{id: 'server_a', name: 'Knowledge', transport: 'http',
        endpoint: 'https://private.example/mcp', apiKey: 'secret', tools: [{name: 'search', inputSchema: {type: 'object'}}]}]);
    expect(result).toEqual([{id: 'mcp__server_5Fa__search', name: 'Knowledge / search', version: '1',
        description: undefined, parameters: {type: 'object'}}]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private.example');
});
