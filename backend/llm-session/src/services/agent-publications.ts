import type {AgentDefinition, AgentPublishedRevision, AgentPublicationStatus, AgentPublishRequest, AgentRevisionContent} from '@itookit/kernel-adapters/contracts';
import type {IFileSystem} from '@itookit/vfs-core';
import type {SystemPromptDefinition} from '@itookit/tools/contracts';
import type {SessionLogger} from '../utils/host-ports';
import {AgentRevisionStore, assertPublishRequest, publicationError} from '../persistence/agent-revisions';
import {agentRevisionDigest, agentSourceDigest, canonicalAgentJson} from './agent-definition-digest';
import {callableExposure} from '@itookit/llm-flow/contracts';
import {assertAgentRevisionContent} from '../persistence/agent-revision-validation';

export interface AgentPublicationDependencies {
    resolveFlow(execution: Extract<NonNullable<AgentDefinition['execution']>, {kind: 'flow'}>): Promise<NonNullable<AgentRevisionContent['flow']>>;
}

/** Publishing changes a definition pointer; it never creates an Invocation or acquires a Connection. */
export class AgentPublications {
    readonly store: AgentRevisionStore;
    dependencies?: AgentPublicationDependencies;
    private readonly pending = new Map<string, {request: AgentPublishRequest; result: Promise<AgentPublishedRevision>}>();
    constructor(fs: IFileSystem, private readonly source: (id: string) => Promise<AgentDefinition>,
        private readonly prompt: (id: string) => Promise<SystemPromptDefinition | null>, private readonly logger: SessionLogger) {
        this.store = new AgentRevisionStore(fs);
    }
    async status(id: string): Promise<AgentPublicationStatus> {
        const content = await this.prepare(await this.source(id)), latest = await this.store.get(id), draftDigest = agentRevisionDigest(content);
        return {sourceDigest: content.sourceDigest, draftDigest, ...(latest ? {latest: {target: latest.target, createdAt: latest.createdAt}} : {}),
            hasDraftChanges: !latest || latest.target.digest !== draftDigest};
    }
    async publish(request: AgentPublishRequest): Promise<AgentPublishedRevision> {
        try {assertPublishRequest(request);}
        catch (error) {this.report(request, 'request', Date.now(), error); throw Object.assign(error as Error, {outcome: 'not-committed'});}
        const prior = this.pending.get(request.operationId);
        if (prior) {
            if (canonicalAgentJson(prior.request) !== canonicalAgentJson(request)) throw publicationError('AGENT_PUBLICATION_OPERATION_CONFLICT');
            return structuredClone(await prior.result);
        }
        const frozen = structuredClone(request), result = this.publishOnce(frozen);
        this.pending.set(frozen.operationId, {request: frozen, result});
        try {return structuredClone(await result);}
        finally {if (this.pending.get(frozen.operationId)?.result === result) this.pending.delete(frozen.operationId);}
    }
    private async publishOnce(request: AgentPublishRequest): Promise<AgentPublishedRevision> {
        const started = Date.now(); let stage = 'receipt';
        try {
            assertPublishRequest(request);
            const existing = await this.store.receipt(request);
            if (existing) {this.report(request, stage, started); return existing;}
            stage = 'source'; const definition = structuredClone(await this.source(request.agentId));
            if (agentSourceDigest(definition) !== request.expectedSourceDigest) throw publicationError('AGENT_SOURCE_CHANGED');
            stage = 'dependencies'; const content = await this.prepare(definition);
            stage = 'persistence'; const revision = await this.store.publish(request, content);
            this.report(request, stage, started); return revision;
        } catch (error) {
            this.report(request, stage, started, error);
            if (knownRejection(error)) Object.assign(error as Error, {outcome: 'not-committed'});
            throw error;
        }
    }
    private async prepare(definition: AgentDefinition): Promise<AgentRevisionContent> {
        const {modifiedAt: _, availability: _availability, ...snapshot} = definition; definition = snapshot;
        validateDefinition(definition); callableExposure(definition.exposure);
        const content: AgentRevisionContent = {definition, sourceDigest: agentSourceDigest(definition)};
        if (definition.config.systemPromptId) {
            const prompt = await this.prompt(definition.config.systemPromptId);
            if (!prompt || prompt.id !== definition.config.systemPromptId || !Array.isArray(prompt.content) || prompt.content.some(item => typeof item !== 'string'))
                throw publicationError('AGENT_PUBLICATION_PROMPT_MISSING');
            content.systemPrompt = structuredClone(prompt);
        }
        if (definition.execution?.kind === 'flow') {
            if (!this.dependencies) throw publicationError('AGENT_PUBLICATION_FLOW_UNAVAILABLE');
            content.flow = await this.dependencies.resolveFlow(definition.execution);
        }
        assertAgentRevisionContent(content); return content;
    }
    private report(request: AgentPublishRequest, stage: string, started: number, error?: unknown): void {
        const code = (error as {code?: unknown})?.code;
        const fields = {operation: 'agent.publish', operationId: safeOperationId(request?.operationId),
            agentId: typeof request?.agentId === 'string' && /^[\w.-]{1,128}$/.test(request.agentId) ? request.agentId : undefined,
            stage, result: error ? 'failure' : 'success', durationMs: Date.now() - started,
            remoteCode: safeRemoteCode(error),
            errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : error ? 'AGENT_PUBLICATION_FAILED' : undefined};
        try {
            if (error) this.logger.warn('Agent publication', fields); else this.logger.info('Agent publication', fields);
        } catch { /* Diagnostics cannot replace a durable outcome or the original rejection. */ }
    }
}
function safeRemoteCode(error: unknown): string | undefined {
    const value = (error as {remoteCode?: unknown})?.remoteCode;
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}
function safeOperationId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : undefined;}
function knownRejection(error: unknown): boolean {
    return ['AGENT_SOURCE_CHANGED', 'AGENT_PUBLICATION_DEPENDENCY_CHANGED', 'AGENT_PUBLICATION_CONFLICT', 'AGENT_PUBLICATION_OPERATION_CONFLICT',
        'AGENT_PUBLICATION_REQUEST_INVALID', 'AGENT_PUBLICATION_DEFINITION_INVALID', 'AGENT_PUBLICATION_PROMPT_MISSING', 'AGENT_PUBLICATION_PROMPT_INVALID', 'AGENT_SOURCE_MISSING', 'AGENT_PUBLICATION_FLOW_UNAVAILABLE',
        'AGENT_PUBLICATION_FLOW_INVALID', 'AGENT_PUBLICATION_DEFAULTS_INVALID', 'AGENT_PUBLICATION_UNSUPPORTED', 'CALLABLE_LOCAL_ONLY'].includes(String((error as {code?: unknown})?.code));
}
function validateDefinition(definition: AgentDefinition): void {
    if (!definition || typeof definition.name !== 'string' || !definition.name.trim() || !definition.config || typeof definition.config !== 'object'
        || Array.isArray(definition.config) || !['agent', 'workflow', 'composite', 'tool'].includes(definition.type)) throw publicationError('AGENT_PUBLICATION_DEFINITION_INVALID');
    if (definition.execution && !['agent', 'harness', 'flow'].includes(definition.execution.kind)) throw publicationError('AGENT_PUBLICATION_DEFINITION_INVALID');
}
