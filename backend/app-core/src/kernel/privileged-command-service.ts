import type { Kernel } from '@itookit/durable-kernel';
import {
    AgentResolver,
    type IAgentConfigService,
    type IPrivilegedCommandService,
    type PlanCommandRequest,
    type ExecCommandRequest,
} from '@itookit/llm-session';
import { randomUUID } from '@itookit/common';
import { submitRun } from '@itookit/llm-flow';
import {toolCommandCatalog, submitToolCommand, type ToolCommandPorts} from './tool-commands';

export class PrivilegedCommandService implements IPrivilegedCommandService {
    private readonly agents: AgentResolver;

    constructor(
        private readonly kernel: Pick<Kernel, 'openSession'>,
        agentService: IAgentConfigService,
        private readonly toolPorts?: ToolCommandPorts,
    ) {
        this.agents = new AgentResolver(agentService);
    }

    async tools(sessionId: string): Promise<import('@itookit/llm-session/contracts').ToolCommandOption[]> {
        if (!this.toolPorts) throw new Error('TOOL_COMMAND_UNAVAILABLE');
        return toolCommandCatalog(this.toolPorts, sessionId);
    }
    async tool(request: import('@itookit/llm-session/contracts').ToolCommandRequest): Promise<string> {
        if (!this.toolPorts) throw new Error('TOOL_COMMAND_UNAVAILABLE');
        return submitToolCommand(this.kernel, this.toolPorts, request);
    }

    async plan(request: PlanCommandRequest): Promise<string> {
        const config = await this.agents.reResolveModel(await this.agents.resolveForChat(request.agentId), { connectionId: request.connectionId });
        if (!config.connectionId) throw new Error('No LLM connection configured');
        const run = await submitRun({
            kind: 'task', sessionId: request.sessionId,
            task: {
                program: { kind: 'llm.plan', version: '1' },
                input: {
                    sessionId: request.sessionId,
                    roundId: createRunId('plan'),
                    connectionId: config.connectionId,
                    model: config.model,
                    temperature: config.temperature,
                    thinking: config.enableThinking,
                    reasoningEffort: config.reasoningEffort,
                    goal: request.goal,
                },
                labels: { command: 'plan' },
            },
            capabilities: [{ kind: 'llm', uri: 'llm://plan', rights: ['execute'], signalKey: 'llmHandleId' }],
        }, { kernel: this.kernel });
        return run.root.id;
    }

    async exec(request: ExecCommandRequest): Promise<string> {
        const run = await submitRun({
            kind: 'task', sessionId: request.sessionId,
            task: {
                program: { kind: 'kernel-adapters.exec', version: '1' },
                input: { command: request.command },
                labels: { command: 'exec' },
            },
            capabilities: [{ kind: 'process', uri: 'process://exec', rights: ['execute'], signalKey: 'processHandleId' }],
        }, { kernel: this.kernel });
        return run.root.id;
    }
}

function createRunId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
}
