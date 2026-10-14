export interface ContextCompactionPolicy {
    /** Prune before each model exchange above this count; policy/user messages and tool groups may exceed it. */
    maxMessages: number;
    /** Preserve at least this many recent messages, capped at maxMessages, expanding to complete tool groups. */
    keepRecent?: number;
    /** Hard input budget including message envelopes and tool schemas. */
    maxInputTokens?: number;
    strategy?: 'prune' | 'summary-tail' | 'checkpoint-reset';
    summaryTokens?: number;
    maxToolOutputBytes?: number;
}
