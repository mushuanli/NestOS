// @file: llm-conversation/session/agent-resolver.ts

import { ExecutorConfig } from '../core/types';
import { resolveModelForTier, resolveWebSearchStrategy } from '../contracts';
import { ModelTier } from '@itookit/driver-llm/contracts';
import { sha256Hex } from '@itookit/llm-context';
import type { ConnectionMeta } from '@itookit/driver-llm/contracts';
import type { WebSearchMode } from '../contracts';
import { IAgentConfigService } from '../services/agent-service';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import { createSessionHost, type SessionHost } from '../utils/host-ports';

export interface AgentInfo {
    id: string;
    name: string;
    icon?: string;
    category?: string;
    description?: string;
}

export interface ModelInfo {
    id: string;
    name: string;
    provider?: string;
}

/** Why an agentId could not be turned into a usable ExecutorConfig. */
export interface AgentResolutionFailure {
    reason: 'not-found' | 'error';
    detail?: string;
}

export interface AgentResolutionPolicy {
    /** Reject missing agents or provide a host-defined fallback. Default preserves the legacy fallback. */
    missingAgent?: 'reject' | ((agentId: string, failure: AgentResolutionFailure | null) => ExecutorConfig | Promise<ExecutorConfig>);
}

function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Agent 解析器
 *
 * 将 agentId 解析为 ExecutorConfig。
 * ConnectionMeta（不含 apiKey）供 UI 和模型列表使用；
 * 完整连接（含 apiKey）由 LLMDeviceDriver 内部通过 connectionId 解析。
 */
export class AgentResolver {
    constructor(private agentService: IAgentConfigService,
        private readonly resolveSessionSkills?: (sessionId: string, ids: string[]) => Promise<import('../contracts').LLMSkill[]>,
        private readonly resolveMCPProfiles?: (sessionId: string, ids: string[]) => Promise<string[]>,
        private readonly host: SessionHost = createSessionHost(),
        private readonly policy: AgentResolutionPolicy = {}) {}

    async getMCPToolIds(ids: string[], sessionId: string): Promise<string[]> {
        if (!ids.length) return [];
        if (!this.resolveMCPProfiles) throw new Error('MCP profile resolution is unavailable');
        return this.resolveMCPProfiles(sessionId, ids);
    }

    /**
     * Resolve agent for chat — falls back to Default Agent if not found.
     * This is the standard chat path where users may not have configured an agent.
     */
    async resolve(agentId: string): Promise<ExecutorConfig> {
        return this.resolveForChat(agentId);
    }

    /**
     * Resolve agent for chat — uses Default Agent fallback on missing agent.
     *
     * The fallback config carries no agentVersion, so any caller that requires a
     * frozen agent identity (SessionRunCoordinator.createTask) fails with
     * "Agent version is required: default". Always log WHY the fallback fired —
     * the module logger is an in-memory ring buffer and is invisible in the app console.
     */
    async resolveForChat(agentId: string): Promise<ExecutorConfig> {
        let config: ExecutorConfig | null = null;
        let failure: AgentResolutionFailure | null = null;

        try {
            const agentDef = await this.agentService.getAgentConfig(agentId);

            if (agentDef) {
                config = await this.buildConfig(agentDef);
            } else {
                failure = { reason: 'not-found' };
            }
        } catch (e) {
            if (e instanceof ConversationError) throw e;
            failure = { reason: 'error', detail: describeError(e) };
            this.host.logger.error('Failed to resolve agent', { agentId, error: e });
        }

        if (!config) {
            this.reportFallback(agentId, failure);
            config = await this.resolveMissingAgent(agentId, failure);
        }

        return config;
    }

    private async resolveMissingAgent(agentId: string, failure: AgentResolutionFailure | null): Promise<ExecutorConfig> {
        const policy = this.policy.missingAgent;
        if (policy === 'reject') throw new ConversationError(ConversationErrorCode.AGENT_NOT_FOUND, `Agent not found: ${agentId}`);
        return policy ? policy(agentId, failure) : this.getFallbackConfig();
    }

    private reportFallback(agentId: string, failure: AgentResolutionFailure | null): void {
        this.host.logger.warn('Agent resolution failed', { agentId, failure });
    }

    /**
     * Resolve agent exactly — no fallback.
     * Throws if agent or version is not found. Used by Kernel where
     * silent fallback would mask configuration errors.
     */
    async resolveExact(agentId: string, version?: string): Promise<ExecutorConfig> {
        const agentDef = await this.agentService.getAgentConfig(agentId);

        if (!agentDef) {
            throw new ConversationError(
                ConversationErrorCode.AGENT_NOT_FOUND,
                `Agent not found: ${agentId}. Kernel requires exact agent resolution.`,
            );
        }

        if (version && (!agentDef.version || agentDef.version !== version)) {
            throw new ConversationError(
                ConversationErrorCode.AGENT_NOT_FOUND,
                `Agent version mismatch: requested ${version ?? '(missing)'}, found ${agentDef.version ?? '(unversioned)'}`,
            );
        }

        return this.buildConfig(agentDef);
    }

    /** Resolve a System Prompt library entry by id. */
    async getSystemPrompt(id: string): Promise<import('@itookit/llm-tasks/contracts').SystemPromptDefinition | null> {
        return this.agentService.getSystemPrompt(id);
    }

    /** Resolve enabled static Skills in declaration order. */
    async getSkills(ids: string[], sessionId?: string): Promise<import('../contracts').LLMSkill[]> {
        if (!ids.length) return [];
        if (sessionId && this.resolveSessionSkills) return this.resolveSessionSkills(sessionId, ids);
        const byId = new Map((await this.agentService.getSkills()).map(skill => [skill.id, skill]));
        return ids.map(id => byId.get(id)).filter((skill): skill is import('../contracts').LLMSkill => Boolean(skill?.enabled));
    }

    /** Build ExecutorConfig from an AgentDefinition. */
    private async buildConfig(agentDef: import('../contracts').AgentDefinition): Promise<ExecutorConfig> {
        const systemPromptSegments: string[] = [];
        if (agentDef.config.systemPromptId) {
            const prompt = await this.agentService.getSystemPrompt(agentDef.config.systemPromptId);
            if (!prompt) throw new ConversationError(ConversationErrorCode.AGENT_NOT_FOUND,
                `System prompt not found: ${agentDef.config.systemPromptId}`);
            systemPromptSegments.push(...prompt.content);
        }
        const additional = agentDef.systemPrompt ?? agentDef.config.systemPrompt;
        if (additional) systemPromptSegments.push(additional);

        return {
            id: agentDef.id,
            name: agentDef.name,
            type: 'agent',
            systemPrompt: systemPromptSegments,
            icon: agentDef.icon,
            temperature: agentDef.config.temperature,
            agentVersion: agentDef.version ?? await this.hashDefinition(agentDef),
            capabilityPolicy: structuredClone(agentDef.capabilityPolicy ?? (agentDef.config.mcpServers?.length
                ? { mcpProfileIds: [...agentDef.config.mcpServers] } : undefined)),
            memoryPolicy: structuredClone(agentDef.memoryPolicy),
            defaultContextPolicy: structuredClone(agentDef.defaultContextPolicy),
        } as ExecutorConfig;
    }

    private async hashDefinition(agentDef: import('../contracts').AgentDefinition): Promise<string> {
        const canonical = this.canonicalize({
            ...agentDef,
            version: undefined,
            modifiedAt: undefined,
        });
        // sha256Hex falls back to pure JS where crypto.subtle is missing (WebKitGTK/Tauri).
        return sha256Hex(canonical);
    }

    private canonicalize(value: unknown): string {
        if (Array.isArray(value)) return `[${value.map(item => this.canonicalize(item)).join(',')}]`;
        if (value && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
                .map(key => `${JSON.stringify(key)}:${this.canonicalize(record[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    async getAvailableAgents(): Promise<AgentInfo[]> {
        try {
            const agents = await this.agentService.getAgents();
            const list: AgentInfo[] = [{
                id: 'default', name: 'Default Assistant', icon: '🤖',
                category: 'System', description: 'Built-in default assistant',
            }];
            for (const agent of agents) {
                list.push({
                    id: agent.id, name: agent.name, icon: agent.icon,
                    category: agent.type === 'agent' ? 'Agents' : 'Workflows',
                    description: agent.description,
                });
            }
            return list;
        } catch (e) {
            this.host.logger.error('Failed to get available agents', { error: e });
            return [{ id: 'default', name: 'Default Assistant', icon: '🤖', category: 'System' }];
        }
    }

    async getModelsForAgent(agentId: string): Promise<ModelInfo[]> {
        try {
            const connMeta = await this.agentService.getDefaultConnection();
            // Model catalog is now on the Provider, not ConnectionMeta.
            // Return the resolved optimal model as the only option.
            if (!connMeta?.model) return [];
            return [{ id: connMeta.model, name: connMeta.model, provider: connMeta.name }];
        } catch (e) {
            this.host.logger.error('getModelsForAgent failed', { agentId, error: e });
            return [];
        }
    }

    /**
     * 记录一次 LLM 用量到 cost.seq（按 sessionId|providerId|date 累加）。
     */
    async recordUsageCost(
        connectionId: string,
        sessionId: string,
        usage: {
            inputTokens: number;
            outputTokens: number;
            cost: number;
            cacheWriteTokens?: number;
            cacheReadTokens?: number;
        },
    ): Promise<void> {
        if (!connectionId) return;
        try {
            const connMeta = await this.agentService.getConnection(connectionId);
            if (!connMeta) return;
            const svc = this.agentService as unknown as {
                recordCost?(p: unknown): Promise<void>;
            };
            await svc.recordCost?.({
                sessionId,
                providerId:   connMeta.providerId,
                connectionId,
                modelId:      connMeta.model,
                usage,
            });
        } catch (e) {
            this.host.logger.error('Failed to record usage cost', { connectionId, sessionId, error: e });
        }
    }

    /**
     * 根据 overrides 重解析模型 ID。
     *
     * 当用户切换连接或模型层级时，需要重新查新连接的 tiers 映射来解析模型。
     */
    async reResolveModel(config: ExecutorConfig, overrides: {
        connectionId?: string;
        modelTier?: ModelTier;
        allowUnconfigured?: boolean;
    }): Promise<ExecutorConfig> {
        const connId = overrides.connectionId ?? config.connectionId;
        const connMeta = connId ? await this.agentService.getConnection(connId) : await this.agentService.getDefaultConnection();
        if (!connMeta && !connId && overrides.allowUnconfigured) return config;
        if (!connMeta) throw new Error(connId ? `Connection not found: ${connId}` : 'No default connection configured');
        const provider = this.agentService.getProvider(connMeta.providerId);
        if (connMeta.enabled === false || provider?.enabled === false) throw new Error(`Connection is disabled: ${connMeta.id}`);
        const tier = overrides.modelTier ?? 'optimal';
        const model = resolveModelForTier(connMeta, tier);
        if (!model) throw new Error(`Connection has no model: ${connMeta.id}`);
        return { ...config, connectionId: connMeta.id, model,
            temperature: config.temperature ?? connMeta.temperature,
            ...this.resolveThinkingConfig(connMeta, tier, model), webSearchMode: this.resolveWebSearch(connMeta) };
    }

    /** Derive enableThinking and reasoningEffort from connection metadata + model supportsThinking flag. */
    private resolveThinkingConfig(
        connMeta: ConnectionMeta,
        tier: ModelTier,
        modelId: string,
    ): { enableThinking: boolean; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined } {
        const pid = connMeta.providerId;
        const cmData = connMeta.metadata as Record<string, unknown> | undefined;
        const modelEfforts = cmData?.modelReasoningEfforts as Record<string, 'low' | 'medium' | 'high' | 'xhigh'> | undefined;
        const tierThinking = cmData?.tierThinking as Record<string, boolean> | undefined;
        const tierOverride = tierThinking?.[tier];

        let enableThinking = false;
        if (pid && modelId) {
            const provider = this.agentService.getProvider(pid);
            const modelDef = provider?.models.find(m => m.id === modelId);
            // Per-tier override takes priority; fall back to model's supportsThinking default.
            enableThinking = tierOverride !== undefined ? tierOverride : (modelDef?.supportsThinking ?? true);
        }

        return {
            enableThinking,
            reasoningEffort: (modelEfforts?.[modelId] ?? cmData?.reasoningEffort) as 'low' | 'medium' | 'high' | 'xhigh' | undefined,
        };
    }

    /**
     * 解析联网搜索策略三态：provider 支持内置 server-side search 且当前协议可用
     * 则走底层（'builtin'），否则依赖客户端统一工具（'client-tool'）。
     * 返回判别联合（非两个布尔），杜绝「内置+客户端」非法态。
     */
    private resolveWebSearch(
        connMeta: ConnectionMeta,
        enabled = true,
    ): WebSearchMode {
        const provider = this.agentService.getProvider(connMeta.providerId);
        return resolveWebSearchStrategy(provider?.capabilities, enabled, connMeta.protocol);
    }

    private async getFallbackConfig(): Promise<ExecutorConfig> {
        return { id: 'default', name: 'Unknown Agent', type: 'agent' };
    }
}
