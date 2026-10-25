import type {AgentDefinition, AgentRevisionContent} from '@itookit/kernel-adapters/contracts';
import {callableExposure} from '@itookit/llm-flow/contracts';

/** Publication validates platform fields; business argument names are owned by the Flow schema. */
export function assertAgentRevisionContent(content: AgentRevisionContent): void {
    if (!content || !validDefinition(content.definition) || !/^[a-f0-9]{64}$/.test(content.sourceDigest) || !safeJson(content)) throw invalid();
    validateDefinitionFields(content.definition);
    callableExposure(content.definition.exposure);
    validatePrompt(content); validateFlow(content);
    const fields = ['definition', 'sourceDigest', 'systemPrompt', 'flow', 'schemaVersion', 'target', 'createdAt'];
    if (Object.keys(content).some(key => !fields.includes(key))) throw invalid();
}
function validateDefinitionFields(definition: AgentDefinition): void {
    const fields = ['id', 'exposure', 'version', 'name', 'type', 'icon', 'description', 'config', 'modelDefaults', 'composition', 'execution',
        'tags', 'interface', 'defaultPrompts', 'createdAt', 'modifiedAt', 'systemPrompt', 'capabilityPolicy', 'memoryPolicy', 'defaultContextPolicy'];
    if (Object.keys(definition).some(key => !fields.includes(key))) throw invalid();
    const policies: Array<[unknown, string[]]> = [
        [definition.config, ['imageProcessing', 'systemPrompt', 'systemPromptId', 'maxHistoryLength', 'temperature', 'mcpServers']],
        [definition.capabilityPolicy, ['toolIds', 'skillIds', 'mcpProfileIds']],
        [definition.memoryPolicy, ['namespaceId', 'readScopes', 'writeScopes', 'retrievalLimit']],
        [definition.defaultContextPolicy, ['tokenBudget', 'automaticCompression']],
        [definition.execution, ['kind', 'connectionId', 'flowId', 'revision', 'parameters', 'connectionBindings']],
    ];
    if (policies.some(([value, keys]) => !knownFields(value, keys))) throw invalid();
}
function knownFields(value: unknown, keys: string[]): boolean {
    return value === undefined || !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function validatePrompt(content: AgentRevisionContent): void {
    const promptId = content.definition.config.systemPromptId;
    if (promptId && (!content.systemPrompt || content.systemPrompt.id !== promptId || !Array.isArray(content.systemPrompt.content)
        || content.systemPrompt.content.some(item => typeof item !== 'string'))) throw invalid();
    if (!promptId && content.systemPrompt !== undefined) throw invalid();
}
function validDefinition(definition: AgentDefinition): boolean {
    return !!definition && typeof definition.id === 'string' && !!definition.id.trim() && typeof definition.name === 'string' && !!definition.name.trim()
        && !!definition.config && typeof definition.config === 'object' && !Array.isArray(definition.config)
        && ['agent', 'workflow', 'composite', 'tool'].includes(definition.type) && definition.availability === undefined;
}
function validateFlow(content: AgentRevisionContent): void {
    const execution = content.definition.execution;
    if (execution && !['agent', 'flow', 'harness'].includes(execution.kind)) throw invalid();
    if (execution?.kind !== 'flow') {if (content.flow !== undefined) throw invalid(); return;}
    validateFlowLock(content.flow, execution);
}
function validateFlowLock(flow: AgentRevisionContent['flow'], execution: Extract<NonNullable<AgentDefinition['execution']>, {kind: 'flow'}>): void {
    if (!flow || flow.id !== execution.flowId || !Number.isSafeInteger(flow.revision) || flow.revision < 1
        || typeof flow.digest !== 'string' || !flow.digest || execution.revision !== undefined && execution.revision !== flow.revision) throw invalid();
}
function safeJson(value: unknown, depth = 0): boolean {
    if (depth > 64) return false;
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(child => safeJson(child, depth + 1));
    if (typeof value !== 'object') return false;
    return Object.values(value).every(child => safeJson(child, depth + 1));
}
function invalid(): Error {return Object.assign(new Error('Invalid published Agent policy or dependencies'), {code: 'AGENT_PUBLICATION_DEFINITION_INVALID'});}
