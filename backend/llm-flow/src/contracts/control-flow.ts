/** Waiting, result collection and sibling control are separate policies. */
export interface FlowWaitPolicy {
    mode: 'all' | 'any' | 'first-success' | 'quorum';
    quorum?: number;
    remaining?: 'continue' | 'cancel';
    failure?: 'fail' | 'partial';
    result?: 'collect' | 'discard';
}

export interface FlowTaskGroupConfig {
    maxConcurrency: number;
    /** Compiler-owned member identities; each member keeps its own durable Task. */
    members?: string[];
    joinId?: string;
}

export interface FlowLoopConfig {
    maxRounds: number;
    /** Compiler-owned identities for the bounded cycle. */
    members?: string[];
}
