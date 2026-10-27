import {expect, it, vi} from 'vitest';
import type {IPrivilegedCommandService} from '@itookit/llm-session/contracts';
import {prepareToolInvocation} from './invoke-tool';

it('prepares explicit MCP arguments without executing the tool', async () => {
    const tool = vi.fn();
    const service = {tools: async () => [{id: 'mcp__knowledge__search', name: 'Search', version: '2'}], tool} as unknown as IPrivilegedCommandService;
    expect(await prepareToolInvocation(service, 's', 'mcp__knowledge__search {"query":"recent"}', new AbortController().signal, true))
        .toEqual({toolId: 'mcp__knowledge__search', toolVersion: '2', args: {query: 'recent'}});
    expect(tool).not.toHaveBeenCalled();
    await expect(prepareToolInvocation(service, 's', 'mcp__knowledge__search []', new AbortController().signal)).rejects.toThrow();
});
