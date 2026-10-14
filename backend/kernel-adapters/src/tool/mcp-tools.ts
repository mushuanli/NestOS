import type { MCPDiscovery } from '@itookit/tools/mcp-contracts';
import type { IToolService, ToolDefinition, ToolExecutionContext } from '@itookit/tools/contracts';
import type { DeviceContext, IDeviceDriver } from '@itookit/vfs-core';
import { createToolProgressReporter } from '@itookit/tools';
import { LLM_IOCTL } from '../llm-management/contracts/device';

const encode = (value: string) => encodeURIComponent(value).replace(/_/g, '%5F').replace(/%/g, '_');
const decode = (value: string) => decodeURIComponent(value.replace(/_([0-9A-F]{2})/g, '%$1'));
export const mcpToolId = (server: string, tool: string) => `mcp__${encode(server)}__${encode(tool)}`;

export const mcpResourceToolId = (server: string) => `mcp_resource__${encode(server)}`;
export const mcpPromptToolId = (server: string) => `mcp_prompt__${encode(server)}`;

/** MCP device sessions never escape into Flow definitions or model arguments. */
export class MCPToolAdapter {
    constructor(private readonly driver: IDeviceDriver) {}

    private async session<T>(server: string, use: (context: DeviceContext) => Promise<T>): Promise<T> {
        if (!this.driver.open || !this.driver.ioctl) throw new Error('MCP device is unavailable');
        const base: DeviceContext = { nodeId: 'llm', name: 'llm', metadata: { resourceType: 'mcp', resourceId: server } };
        const sessionId = await this.driver.open(base, { resourceType: 'mcp', resourceId: server });
        const context = { ...base, sessionId };
        try { return await use(context); }
        finally { await this.driver.close?.(context); }
    }

    async call(server: string, tool: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
        context.signal?.throwIfAborted();
        const progress = createToolProgressReporter(context.onProgress);
        const onProgress = (value: { progress: number; total?: number; message?: string }) => {
            progress.update({ message: `${value.message ?? tool} (${value.progress}${value.total === undefined ? '' : `/${value.total}`})` });
        };
        let result: unknown;
        try { result = await this.session(server, device => this.driver.ioctl!(device, LLM_IOCTL.MCP_CALL_TOOL,
            { tool, args, timeout: context.timeoutMs, signal: context.signal, onProgress })); }
        finally { await progress.finish(); }
        if (result && typeof result === 'object' && 'isError' in result && result.isError) {
            throw new Error(`MCP tool failed: ${JSON.stringify(result)}`);
        }
        return typeof result === 'string' ? result : JSON.stringify(result);
    }

    async resolveProfiles(profiles: string[]): Promise<string[]> {
        const ids: string[] = [];
        for (const server of new Set(profiles)) {
            const catalog = await this.discover(server);
            ids.push(...catalog.tools.map(tool => mcpToolId(server, tool.name)));
            if (catalog.capabilities?.resources) ids.push(mcpResourceToolId(server));
            if (catalog.capabilities?.prompts) ids.push(mcpPromptToolId(server));
        }
        return ids;
    }

    private discover(server: string): Promise<MCPDiscovery> {
        return this.session(server, device => this.driver.ioctl!(device, LLM_IOCTL.MCP_DISCOVER)) as Promise<MCPDiscovery>;
    }

    private async prepareContent(service: IToolService, id: string): Promise<void> {
        const [kind, encoded] = id.split('__'); const server = decode(encoded);
        const resource = kind === 'mcp_resource';
        if ((resource ? mcpResourceToolId(server) : mcpPromptToolId(server)) !== id) throw new Error(`Invalid MCP capability ID: ${id}`);
        const catalog = await this.discover(server);
        if (!(resource ? catalog.capabilities?.resources : catalog.capabilities?.prompts)) throw new Error(`MCP capability unavailable: ${id}`);
        const description = (resource ? 'Read an MCP resource by URI from this authorized server. Available resources: ' : 'Get an MCP prompt with arguments from this authorized server. Available prompts: ')
            + JSON.stringify(resource ? catalog.resources : catalog.prompts).slice(0, 16000);
        const parameters = resource ? { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false }
            : { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['name'], additionalProperties: false };
        service.registerTool({ id, name: id, description, type: 'mcp', sideEffect: 'external', timeoutMs: 30000, enabled: true },
            { type: 'function', function: { name: id, description, parameters } }, async (args, context) => {
                context.signal?.throwIfAborted();
                const result = await this.session(server, device => this.driver.ioctl!(device,
                    resource ? LLM_IOCTL.MCP_READ_RESOURCE : LLM_IOCTL.MCP_GET_PROMPT, { ...args, signal: context.signal }));
                return JSON.stringify(result);
            });
    }

    async prepare(service: IToolService, ids: string[]): Promise<void> {
        for (const id of ids) {
            if (id.startsWith('mcp_resource__') || id.startsWith('mcp_prompt__')) { await this.prepareContent(service, id); continue; }
            if (!id.startsWith('mcp__')) continue;
            const parts = id.split('__');
            if (parts.length !== 3) throw new Error(`Invalid MCP tool ID: ${id}`);
            const server = decode(parts[1]); const name = decode(parts[2]);
            if (mcpToolId(server, name) !== id) throw new Error(`Noncanonical MCP tool ID: ${id}`);
            const definitions = await this.session(server, device => this.driver.ioctl!(device, LLM_IOCTL.MCP_LIST_TOOLS)) as ToolDefinition[];
            const definition = definitions.find(tool => (tool.function?.name ?? tool.name) === name);
            if (!definition) throw new Error(`MCP tool not found: ${id}`);
            const named = definition.function ? { ...definition, function: { ...definition.function, name: id } } : { ...definition, name: id };
            service.registerTool({ id, name: id, description: String(definition.function?.description ?? definition.description ?? ''),
                type: 'mcp', sideEffect: 'external', timeoutMs: 30000, enabled: true }, named,
            (args, context) => this.call(server, name, args, context));
        }
    }
}
