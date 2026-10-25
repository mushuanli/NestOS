// @file: llm-conversation/session/agent-resolver.ts

import { ExecutorConfig } from '../core/types';
import { resolveModelForTier, resolveWebSearchStrategy } from '../contracts';
import { modelReasoning, getProviderDefaultProtocol, type ModelTier } from '@itookit/driver-llm/contracts';
import {agentDefinitionDigest, publishedAgentDefinition} from '../services/agent-definition-digest';
import type {AgentPublishedRevision} from '@itookit/kernel-adapters/contracts';
import type { ConnectionMeta } from '@itookit/driver-llm/contracts';
import type { WebSearchMode } from '../contracts';
import { IAgentConfigService } from '../services/agent-service';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import { createSessionHost, type SessionHost } from '../utils/host-ports';
import { admitHarnessConnection } from './harness-binding';
import { assertRootCallable, callableExposure, isRootCallable, CallableExposureError, sameTargetRef, type TargetRef } from '@itookit/llm-flow/contracts';
import { ulid } from '../persistence/ulid';

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
        const operationId = ulid(), started = Date.now();
        try {
            let {config, failure} = await this.readChatIdentity(agentId);
            if (!config) {
                this.reportFallback(agentId, failure);
                config = await this.resolveMissingAgent(agentId, failure);
            }
            assertRootCallable(config);
            return config;
        } catch (error) {
            if (error instanceof CallableExposureError) this.host.logger.warn('Agent root admission rejected', {
                operation: 'agent.resolve', operationId, agentId, stage: 'exposure', result: 'failure',
                code: error.code, durationMs: Date.now() - started,
            });
            throw error;
        }
    }

    private async readChatIdentity(agentId: string): Promise<{config: ExecutorConfig | null; failure: AgentResolutionFailure | null}> {
        try {
            const selected = await this.readDefinition(agentId);
            if (!selected) return {config: null, failure: {reason: 'not-found'}};
            assertRootCallable(selected.definition);
            return {config: await this.buildConfig(selected.definition, selected.revision), failure: null};
        } catch (error) {
            if (error instanceof ConversationError || error instanceof CallableExposureError
                || /^AGENT_(REVISION|PUBLICATION)_/.test(String((error as {code?: unknown})?.code))) throw error;
            this.host.logger.error('Failed to resolve agent', {agentId, error});
            return {config: null, failure: {reason: 'error', detail: describeError(error)}};
        }
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
        const selected = await this.readDefinition(agentId, version);
        if (!selected) {
            throw new ConversationError(
                ConversationErrorCode.AGENT_NOT_FOUND,
                `Agent not found: ${agentId}. Kernel requires exact agent resolution.`,
            );
        }

        const config = await this.buildConfig(selected.definition, selected.revision);
        if (version && config.agentVersion !== version) {
            throw new ConversationError(
                ConversationErrorCode.AGENT_NOT_FOUND,
                `Agent version mismatch: requested ${version}, found ${config.agentVersion}`,
            );
        }

        return config;
    }

    private async readDefinition(agentId: string, version?: string): Promise<{definition: import('../contracts').AgentDefinition; revision?: AgentPublishedRevision} | null> {
        const definition = await this.agentService.getAgentConfig(agentId);
        if (!definition) {
            if (await this.agentService.getAgentRevision?.(agentId, version))
                throw new ConversationError(ConversationErrorCode.AGENT_NOT_FOUND, 'Published Agent resource was removed');
            return null;
        }
        const revision = await this.agentService.getAgentRevision?.(agentId, version);
        if (revision) return {definition: publishedAgentDefinition(revision), revision};
        if (version && await this.agentService.getAgentRevision?.(agentId))
            throw new ConversationError(ConversationErrorCode.AGENT_NOT_FOUND, 'Legacy Agent version cannot select an unpublished draft');
        return {definition};
    }

    async publishedTarget(target?: TargetRef): Promise<AgentPublishedRevision | null> {
        if (target?.kind !== 'agent') return null;
        const revision = await this.agentService.getAgentRevision?.(target.id, target.version);
        return revision && sameTargetRef(revision.target, target) ? revision : null;
    }

    /** Definition metadata does not require credentials, native attachment or prompt-library reads. */
    async describeTarget(agent: import('../contracts').AgentDefinition): Promise<import('@itookit/llm-flow/contracts').TargetRef> {
        callableExposure(agent.exposure);
        const digest = agentDefinitionDigest(agent);
        return {kind: 'agent', id: agent.id, version: agent.version ?? digest, digest};
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
    private async buildConfig(agentDef: import('../contracts').AgentDefinition, publication?: AgentPublishedRevision): Promise<ExecutorConfig> {
        callableExposure(agentDef.exposure);
        if (agentDef.availability?.status === 'disabled') throw new ConversationError(ConversationErrorCode.AGENT_DISABLED,
            `Agent unavailable: ${agentDef.name} (${agentDef.availability.reason ?? 'disabled'})`);
        const systemPromptSegments: string[] = [];
        if (agentDef.config.systemPromptId) {
            const prompt = publication ? publication.systemPrompt : await this.agentService.getSystemPrompt(agentDef.config.systemPromptId);
            if (!prompt) throw new ConversationError(ConversationErrorCode.AGENT_NOT_FOUND,
                `System prompt not found: ${agentDef.config.systemPromptId}`);
            systemPromptSegments.push(...prompt.content);
        }
        const additional = agentDef.systemPrompt ?? agentDef.config.systemPrompt;
        if (additional) systemPromptSegments.push(additional);
        const target = publication?.target ?? await this.describeTarget(agentDef), version = target.version;

        return {
            id: agentDef.id,
            target,
            ...(agentDef.exposure !== undefined ? { exposure: agentDef.exposure } : {}),
            name: agentDef.name,
            type: 'agent',
            systemPrompt: systemPromptSegments,
            icon: agentDef.icon,
            temperature: agentDef.config.temperature,
            ...(agentDef.modelDefaults ? { modelDefaults: structuredClone(agentDef.modelDefaults) } : {}),
            agentVersion: version,
            ...(agentDef.execution ? { execution: structuredClone(agentDef.execution) } : {}),
            ...(agentDef.execution?.kind === 'harness' ? {
                harnessConnection: await this.resolveHarnessConnection(agentDef.execution.connectionId),
            } : {}),
            capabilityPolicy: structuredClone(agentDef.capabilityPolicy ?? (agentDef.config.mcpServers?.length
                ? { mcpProfileIds: [...agentDef.config.mcpServers] } : undefined)),
            memoryPolicy: structuredClone(agentDef.memoryPolicy),
            defaultContextPolicy: structuredClone(agentDef.defaultContextPolicy),
        } as ExecutorConfig;
    }

    async getAvailableAgents(): Promise<AgentInfo[]> {
        try {
            const agents = await this.publishedMetadata();
            const hasDefault = agents.some(agent => agent.id === 'default') || !!await this.agentService.getAgentRevision?.('default');
            const list: AgentInfo[] = hasDefault ? [] : [{
                id: 'default', name: 'Default Assistant', icon: '🤖',
                category: 'System', description: 'Built-in default assistant',
            }];
            for (const agent of agents.filter(isRootCallable)) {
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
    private async publishedMetadata(): Promise<import('../contracts').AgentDefinition[]> {
        return Promise.all((await this.agentService.getAgents()).map(async source => {
            const revision = await this.agentService.getAgentRevision?.(source.id);
            return revision ? publishedAgentDefinition(revision) : source;
        }));
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
    getConnection(id: string) { return this.agentService.getConnection(id); }
    getHarnessConnection(id: string) { return this.agentService.getHarnessConnection?.(id) ?? Promise.resolve(undefined); }
    async resolveHarnessConnection(id: string, saved?: ExecutorConfig['harnessConnection']) {
        const started = Date.now();
        try {
            const snapshot = await admitHarnessConnection(this, id, saved);
            this.host.logger.debug('Harness connection admitted', { operation: 'harness.connection', operationId: id,
                stage: saved ? 'revalidation' : 'admission', result: 'success', elapsedMs: Date.now() - started });
            return snapshot;
        }
        catch (error) {
            this.host.logger.warn('Harness connection admission failed', { operation: 'harness.connection', operationId: id,
                stage: saved ? 'revalidation' : 'admission', result: 'failure', elapsedMs: Date.now() - started,
                errorCode: (error as { code?: string }).code ?? 'HARNESS_CONNECTION_FAILED' });
            throw new ConversationError(ConversationErrorCode.AGENT_DISABLED,
                error instanceof Error ? error.message : 'Harness connection admission failed');
        }
    }
    getProvider(id: string) { return this.agentService.getProvider(id); }
    async getModelDefaults(agent?: Pick<ExecutorConfig, 'modelDefaults'>) {
        return { ...await this.agentService.getModelDefaults?.() ?? {}, ...agent?.modelDefaults };
    }

    async reResolveModel(config: ExecutorConfig, overrides: {
        connectionId?: string;
        modelTier?: ModelTier;
        allowUnconfigured?: boolean;
        useDefault?: boolean;
        frozenConnection?: ConnectionMeta;
    }): Promise<ExecutorConfig> {
        if (config.execution?.kind === 'harness') return { ...config,
            harnessConnection: await this.resolveHarnessConnection(config.execution.connectionId, config.harnessConnection) };
        const connId = overrides.connectionId ?? config.connectionId
            ?? (overrides.useDefault === false ? undefined : config.modelDefaults?.chat);
        const connMeta = connId ? overrides.frozenConnection ?? await this.agentService.getConnection(connId)
            : overrides.useDefault === false ? null : await this.agentService.getDefaultConnection();
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
    ): { enableThinking: boolean; reasoningEffort: string | undefined } {
        const pid = connMeta.providerId;
        const cmData = connMeta.metadata as Record<string, unknown> | undefined;
        const modelEfforts = cmData?.modelReasoningEfforts as Record<string, string> | undefined;
        const reasoningEffort = (modelEfforts?.[modelId] ?? cmData?.reasoningEffort) as string | undefined;
        const configuredThinking = reasoningEffort === undefined ? undefined : reasoningEffort !== 'off';
        const tierThinking = cmData?.tierThinking as Record<string, boolean> | undefined;
        const tierOverride = tierThinking?.[tier];

        let enableThinking = configuredThinking ?? false;
        if (pid && modelId) {
            const provider = this.agentService.getProvider(pid);
            const modelDef = provider?.models.find(m => m.id === modelId);
            const protocol = connMeta.protocol ?? modelDef?.preferredProtocol ?? (provider && getProviderDefaultProtocol(provider));
            const caps = modelReasoning(modelDef, protocol);
            const declaration = protocol && modelDef?.reasoningByProtocol?.[protocol] !== undefined ? modelDef.reasoningByProtocol[protocol] : modelDef?.reasoning;
            const supported = declaration === false ? false : !!caps || (modelDef?.supportsThinking ?? false);
            enableThinking = tierOverride ?? configuredThinking ?? (modelDef?.thinkingMode === 'disabled' ? false : modelDef?.thinkingMode === 'enabled' ? true : supported);
        }

        return {
            enableThinking,
            reasoningEffort,
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
