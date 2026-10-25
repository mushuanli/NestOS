import {sha256HexSync} from '@itookit/llm-context/digest';
import type {AgentDefinition, AgentRevisionContent} from '@itookit/kernel-adapters/contracts';
export {publishedAgentDefinition} from '@itookit/kernel-adapters/contracts';

/** Preserve the pre-publication TargetRef digest for legacy mutable definitions. */
export function agentDefinitionDigest(definition: AgentDefinition): string {
    return sha256HexSync(canonicalAgentJson({...definition, version: undefined, modifiedAt: undefined, availability: undefined}));
}
export function agentSourceDigest(definition: AgentDefinition): string {
    return sha256HexSync(canonicalAgentJson({...definition, modifiedAt: undefined, availability: undefined}));
}
export function agentRevisionDigest(content: AgentRevisionContent): string {
    return sha256HexSync(canonicalAgentJson({schemaVersion: 1, definition: content.definition, sourceDigest: content.sourceDigest,
        ...(content.systemPrompt ? {systemPrompt: content.systemPrompt} : {}), ...(content.flow ? {flow: content.flow} : {})}));
}
export function canonicalAgentJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalAgentJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
            .map(key => `${JSON.stringify(key)}:${canonicalAgentJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
