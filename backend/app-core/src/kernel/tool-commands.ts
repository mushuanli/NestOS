import {bindCapabilities, type Kernel, type TaskHandle} from '@itookit/durable-kernel';
import type {ToolCommandOption, ToolCommandRequest} from '@itookit/llm-session/contracts';
import type {SessionCapabilityRegistry} from '@itookit/kernel-adapters/contracts';
import type {MCPServer} from '@itookit/tools/mcp-contracts';
import {mcpToolId} from '@itookit/tools/mcp-contracts';
import {createModuleLogger} from '@itookit/common';

export interface ToolCommandPorts {
    sessions: Pick<SessionCapabilityRegistry, 'get'>;
    mcpServers(): Promise<MCPServer[]>;
    prepareSession?(sessionId: string): Promise<boolean>;
}
const logger = createModuleLogger('tool-commands');

export async function toolCommandCatalog(ports: ToolCommandPorts, sessionId: string): Promise<ToolCommandOption[]> {
    const scope = await ports.sessions.get(sessionId), service = scope.toolService;
    return configuredToolCatalog(service, await ports.mcpServers());
}
export function configuredToolCatalog(service: Pick<import('@itookit/tools/contracts').IToolService, 'getToolDefinitions' | 'getToolMeta'>,
    servers: MCPServer[]): ToolCommandOption[] {
    const options = service.getToolDefinitions().flatMap(definition => {
        const id = definition.function?.name ?? definition.name;
        if (!id || !service.getToolMeta(id)?.enabled) return [];
        return [{id, name: id, description: definition.function?.description ?? definition.description,
            version: service.getToolMeta(id)?.version ?? '1', parameters: definition.function?.parameters ?? definition.parameters} as ToolCommandOption];
    });
    for (const server of servers) for (const raw of server.tools ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        const tool = raw as {name?: string; description?: string; inputSchema?: Record<string, unknown>; parameters?: Record<string, unknown>;
            function?: {name?: string; description?: string; parameters?: Record<string, unknown>}};
        const name = tool.function?.name ?? tool.name;
        if (typeof name !== 'string' || !name) continue;
        const id = mcpToolId(server.id, name);
        if (!options.some(item => item.id === id)) options.push({id, name: `${server.name} / ${name}`, version: '1',
            description: tool.function?.description ?? tool.description, parameters: tool.function?.parameters ?? tool.inputSchema ?? tool.parameters});
    }
    return options;
}

/** Explicit user calls still use the durable Program, approval and capability boundary. */
export async function submitToolCommand(kernel: Pick<Kernel, 'openSession'>, ports: ToolCommandPorts, request: ToolCommandRequest): Promise<string> {
    const started = Date.now();
    try {
        if (!request.requestId?.trim() || !request.toolId?.trim() || !request.toolVersion?.trim()) throw failure('TOOL_COMMAND_IDENTITY_REQUIRED');
        if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)) throw failure('TOOL_COMMAND_ARGUMENTS_INVALID');
        if (ports.prepareSession && !await ports.prepareSession(request.sessionId)) throw failure('TOOL_COMMAND_SESSION_READ_ONLY');
        const scope = await ports.sessions.get(request.sessionId);
        await scope.prepareTools?.([request.toolId]);
        const meta = scope.toolService.getToolMeta(request.toolId);
        if (!meta?.enabled) throw failure('TOOL_COMMAND_UNAVAILABLE');
        if ((meta.version ?? '1') !== request.toolVersion) throw failure('TOOL_COMMAND_VERSION_UNAVAILABLE');
        const task = await prepareToolTask(kernel, request);
        if ((await task.status()).task.status !== 'created') return task.id;
        await bindCapabilities(task, [{kind: 'tool', uri: 'tool://command', rights: ['execute'], signalKey: 'toolHandleId'}]);
        logger.info('Tool command admitted', diagnostic(request, started, 'success'));
        return task.id;
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        logger.error('Tool command rejected', {...diagnostic(request, started, 'failure'),
            errorCategory: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'TOOL_COMMAND_ADMISSION_FAILED'});
        throw error;
    }
}
async function prepareToolTask(kernel: Pick<Kernel, 'openSession'>, request: ToolCommandRequest): Promise<TaskHandle> {
    const session = await kernel.openSession(request.sessionId);
    return session.submit({requestId: request.requestId, program: {kind: 'kernel-adapters.tool', version: '1'}, deferStart: true,
        input: {toolId: request.toolId, toolVersion: request.toolVersion, args: structuredClone(request.args),
            allowedToolIds: [request.toolId], approval: 'all'}, labels: {command: 'tool', toolRequestId: request.requestId}});
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function diagnostic(request: ToolCommandRequest, started: number, result: string) {
    return {operation: 'tool.command', stage: 'admission', result, operationId: request.requestId,
        sessionId: request.sessionId, toolId: request.toolId, elapsedMs: Date.now() - started};
}
