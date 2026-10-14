import { expect, it, vi } from 'vitest';
import { ToolDeviceDriver } from '@itookit/tools';
import { LLM_IOCTL } from '../llm-management/contracts/device';
import { MCPToolAdapter, mcpToolId, mcpResourceToolId, mcpPromptToolId } from './mcp-tools';

it('exposes only authorized server capabilities, validates arguments and forwards content/progress', async () => {
    const close = vi.fn(async () => {});
    const ioctl = vi.fn(async (_context, command, arg) => {
        if (command === LLM_IOCTL.MCP_DISCOVER) return { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }], resources: [{ uri: 'test://resource', name: 'Resource' }], prompts: [{ name: 'review' }],
            capabilities: { tools: true, resources: true, prompts: true } };
        if (command === LLM_IOCTL.MCP_LIST_TOOLS) return [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
        if (command === LLM_IOCTL.MCP_READ_RESOURCE) return { contents: [{ uri: arg.uri, text: 'RESOURCE' }] };
        if (command === LLM_IOCTL.MCP_GET_PROMPT) return { messages: [{ role: 'user', content: { type: 'text', text: `Review ${arg.args.subject}` } }] };
        if (command === LLM_IOCTL.MCP_CALL_TOOL) { arg.onProgress({ progress: 1, total: 2, message: 'Looking up' }); return { content: [{ type: 'text', text: 'TOOL' }] }; }
        throw new Error('unexpected command');
    });
    const adapter = new MCPToolAdapter({ open: async () => 'device-session', close, ioctl } as never);
    const tools = new ToolDeviceDriver([]); await tools.init();
    try {
        const server = 'server_under_score';
        const ids = await adapter.resolveProfiles([server]);
        expect(ids).toEqual([mcpToolId(server, 'lookup'), mcpResourceToolId(server), mcpPromptToolId(server)]);
        await adapter.prepare(tools, ids);
        for (const id of ids) expect(tools.getToolMeta(id)?.sideEffect).toBe('external');
        const resource = await tools.invoke({ toolId: ids[1], args: { uri: 'test://resource' } });
        expect(resource.success).toBe(true); expect(resource.output).toContain('RESOURCE');
        const prompt = await tools.invoke({ toolId: ids[2], args: { name: 'review', args: { subject: 'code' } } });
        expect(prompt.output).toContain('Review code');
        expect((await tools.invoke({ toolId: ids[1], args: { uri: 42 } })).success).toBe(false);
        const onProgress = vi.fn(async () => {});
        expect((await tools.invoke({ toolId: ids[0], args: {}, onProgress })).success).toBe(true);
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ message: 'Looking up (1/2)' }));
        expect((await tools.invoke({ toolId: mcpResourceToolId('unselected'), args: { uri: 'test://resource' } })).success).toBe(false);
        expect(close).toHaveBeenCalled();
    } finally { await tools.dispose(); }
});
