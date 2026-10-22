import type { FormParameter } from '@itookit/llm-ui/forms';

export interface AgentFlowConnection {
    name: string;
    connectionId?: string;
    description?: string;
    required?: boolean;
}
export interface AgentFlowDefinition {
    parameters?: FormParameter[];
    connections?: AgentFlowConnection[];
}
export interface AgentFlowChoice extends AgentFlowDefinition { id: string; name: string; }
export interface AgentFlowRevision extends AgentFlowDefinition { revision: number; createdAt?: number; }
export interface AgentExecutionOptions {
    openFlow?(id: string): Promise<void>;
    listFlows?(): Promise<AgentFlowChoice[]>;
    listFlowRevisions?(id: string): Promise<AgentFlowRevision[]>;
    getFlowRevision?(id: string, revision?: number): Promise<AgentFlowRevision | null>;
    listConnections?(): Promise<Array<{ id: string; name: string }>>;
}
