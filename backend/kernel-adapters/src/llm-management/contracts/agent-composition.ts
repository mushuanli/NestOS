/** A coordinator selects one bounded batch of member tasks, then summarizes their results. */
export interface AgentComposition {
    coordinatorAgentId: string;
    memberAgentIds: string[];
    maxDelegations?: number;
    maxConcurrency?: number;
}
