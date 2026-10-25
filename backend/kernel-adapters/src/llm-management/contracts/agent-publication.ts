import type {AgentDefinition} from './agent';
import type {SystemPromptDefinition} from '@itookit/tools/contracts';

/** Published policy and dependency identities; credentials and execution state do not belong here. */
export interface AgentRevisionContent {
    definition: AgentDefinition;
    sourceDigest: string;
    systemPrompt?: SystemPromptDefinition;
    flow?: {id: string; revision: number; digest: string};
}
export interface AgentPublishedRevision extends AgentRevisionContent {
    schemaVersion: 1;
    target: {kind: 'agent'; id: string; version: string; digest: string};
    createdAt: number;
}
export interface AgentPublishRequest {
    agentId: string;
    operationId: string;
    expectedSourceDigest: string;
    expectedRevisionDigest: string;
    expectedPublishedVersion: string | null;
}
export interface AgentPublicationStatus {
    sourceDigest: string;
    draftDigest: string;
    latest?: Pick<AgentPublishedRevision, 'target' | 'createdAt'>;
    hasDraftChanges: boolean;
}

/** Derive execution metadata from the frozen dependency lock, never from a newer draft. */
export function publishedAgentDefinition(revision: AgentPublishedRevision): AgentDefinition {
    const definition = structuredClone(revision.definition);
    if (definition.execution?.kind === 'flow' && revision.flow) definition.execution.revision = revision.flow.revision;
    return {...definition, version: revision.target.version};
}
