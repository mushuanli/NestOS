import { expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@itookit/tools/contracts';
import type { ToolExecutionContext } from '@itookit/tools/contracts';
import type { INativeShell } from '@itookit/tools';
import { createSkillToolHandlers } from './tool-handlers';
import { MCPToolAdapter, mcpToolId } from '../tool/mcp-tools';
import { SkillDeviceDriver } from './skill-device-driver';
import { ToolDeviceDriver } from '@itookit/tools';

const skill: SkillDefinition = { id: 'test', name: 'Test', description: '', type: 'prompt', enabled: true,
    instructions: '', tools: [], triggerPatterns: [], autoLoad: false, priority: 1 };
const context: ToolExecutionContext = { cwd: '/workspace', timeoutMs: 1000 };

it('passes shell values as literal argv and forwards cancellation', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '', code: 0 }));
    const shell = { exec } as unknown as INativeShell;
    const binding = { toolId: 'shell', definition: { name: 'shell' }, executionType: 'shell' as const,
        command: 'printf', args: ['%s', '{{value}}'] };
    const handler = createSkillToolHandlers({} as MCPToolAdapter, shell).create(skill, binding)!;
    const signal = new AbortController().signal;
    expect(await handler({ value: "'; touch /tmp/unwanted; $(echo bad)" }, { ...context, signal })).toBe('ok');
    expect(exec).toHaveBeenCalledWith('printf', ['%s', "'; touch /tmp/unwanted; $(echo bad)"], { ...context, signal });
    const unsafe = createSkillToolHandlers({} as MCPToolAdapter, shell).create(skill, { ...binding, args: undefined, command: "echo '{{value}}'" })!;
    await expect(unsafe({ value: 'x' }, context)).rejects.toThrow('args array');
});

it('HTTP handlers preserve method, request body and abort signal', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('result'));
    try {
        const handler = createSkillToolHandlers({} as MCPToolAdapter).create({ ...skill, endpoint: 'https://example.test/tool' },
            { toolId: 'http', definition: { name: 'http' }, executionType: 'http' })!;
        const signal = new AbortController().signal;
        expect(await handler({ value: 0 }, { ...context, signal })).toBe('result');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"value":0}', signal });
    } finally { fetchMock.mockRestore(); }
});

it('rejects unsupported Skill bindings instead of reporting a loaded tool', async () => {
    const skills = new SkillDeviceDriver(); const tools = new ToolDeviceDriver([]);
    skills.setToolService(tools.getService());
    await skills.saveSkill({ ...skill, tools: [{ toolId: 'custom', definition: { name: 'custom' }, executionType: 'handler' }] });
    await expect(skills.loadSkill('test')).rejects.toThrow('No tool handler');
    expect(skills.getLoadedSkills()).toEqual([]);
    await skills.dispose(); await tools.dispose();
});

it('MCP IDs distinguish delimiters and escaped characters', () => {
    expect(mcpToolId('a_b', 'c')).not.toBe(mcpToolId('a', 'b_c'));
    expect(mcpToolId('a__b', 'c')).not.toBe(mcpToolId('a', 'b__c'));
});
