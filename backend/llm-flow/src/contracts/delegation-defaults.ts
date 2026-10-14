/** Canonical defaults shared by validation, runtime and the editor. */
export const DELEGATION_DEFAULTS = Object.freeze({
    toolName: 'delegate_tasks',
    maxTasks: 8,
    maxConcurrency: 4,
    maxDepth: 1,
    order: 'parallel' as const,
    resultMode: 'all' as const,
    failurePolicy: 'fail-fast' as const,
    retryAttempts: 2,
});

export const DELEGATION_LIMITS = Object.freeze({
    maxTasks: 100,
    maxConcurrency: 32,
    maxDepth: 8,
    retryAttempts: 20,
});
