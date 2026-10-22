import type { DagRunSpec } from '@itookit/llm-flow/contracts';
import type { SystemPromptDefinition } from '@itookit/llm-tasks/contracts';
import type { LLMSkill } from './agent';
import type { ExecutorConfig } from '../core/types';

export interface FlowIdentitySnapshot {
    agents: Array<[string, ExecutorConfig]>;
    skills: Array<[string, LLMSkill | null]>;
    prompts: Array<[string, SystemPromptDefinition | null]>;
    mcp: Array<[string, string[]]>;
}

/** Source compilation is fixed at admission; conversation history remains a dispatch input. */
export interface FlowRunPlan {
    version: 1;
    graph: DagRunSpec;
    identities: FlowIdentitySnapshot;
    digest: string;
}
