import type { FlowId, JsonValue } from './flow-definition';
import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export type FlowNodeId = string;

/** Opaque host correlation; the conversation layer does not interpret source policy. */
export interface SessionSubmission { id: string; source: { kind: string; ownerId: string; id: string } }

export interface SendIntent {
    submission?: SessionSubmission;
    branch: {
        mode: 'continue' | 'fork';
        baseRoundId?: string;
        newBranchName?: string;
    };
    retention: {
        mode: 'persistent' | 'temporary';
    };
    execution:
        | { kind: 'agent'; agentId: string; mode?: ChatExecutionMode }
        | { kind: 'flow'; flowId: FlowId; revision?: number; parameters?: Record<string, JsonValue> };
}

export function createAgentSendIntent(agentId: string): SendIntent {
    return {
        branch: { mode: 'continue' },
        retention: { mode: 'persistent' },
        execution: { kind: 'agent', agentId },
    };
}
