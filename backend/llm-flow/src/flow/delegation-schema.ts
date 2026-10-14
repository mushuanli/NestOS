import { DELEGATION_DEFAULTS, type JsonValue } from '../contracts';

/** Editor schema kept separate from the runtime plugin manifest. */
export function delegationSchema(): JsonValue {
    return {
        type: 'object',
        title: 'Dynamic delegation',
        description: 'Let this Agent create a bounded set of child Agent tasks.',
        advancedProperties: ['toolDescription', 'fanout', 'execution', 'wait', 'result', 'join', 'failure', 'budget'],
        properties: {
            enabled: { type: 'boolean', title: 'Enable delegation' },
            toolName: { type: 'string', title: 'Tool name', unsetLabel: `${DELEGATION_DEFAULTS.toolName} (default)` },
            toolDescription: { type: 'string', title: 'Tool description' },
            template: childTemplateSchema(),
            fanout: fanoutSchema(),
            execution: {
                type: 'object', title: 'Child lifetime',
                properties: {
                    mode: { ...enumSchema(['structured', 'detached']), title: 'Lifetime', unsetLabel: 'structured (default)' },
                },
            },
            wait: {
                type: 'object', title: 'Wait policy',
                properties: {
                    mode: { ...enumSchema(['all', 'any', 'first-success', 'quorum']), title: 'Wait mode', unsetLabel: 'all (default)' },
                    quorum: { type: 'integer', title: 'Required successes' },
                    timeoutMs: { type: 'integer', title: 'Group timeout (ms)' },
                    remaining: { ...enumSchema(['continue', 'cancel']), title: 'Remaining tasks', unsetLabel: 'cancel (legacy default)' },
                },
            },
            result: {
                type: 'object', title: 'Result policy',
                properties: {
                    mode: { ...enumSchema(['collect', 'discard']), title: 'Results', unsetLabel: 'collect (default)' },
                    order: { ...enumSchema(['declared', 'completion']), title: 'Result order', unsetLabel: 'declared (default)' },
                },
            },
            join: {
                type: 'object',
                title: 'Legacy result aggregation',
                description: 'all includes child outputs in the Flow result; none excludes them. The Flow still waits for started children.',
                properties: {
                    mode: { ...enumSchema(['all', 'none']), title: 'Include child outputs', unsetLabel: `${DELEGATION_DEFAULTS.resultMode} (default)` },
                },
            },
            failure: failureSchema(),
            budget: {
                type: 'object',
                title: 'Per-request limits',
                description: 'Applied to each model request made by a child Agent.',
                properties: {
                    maxTokens: { type: 'integer', title: 'Maximum output tokens' },
                    timeoutMs: { type: 'integer', title: 'Timeout (ms)' },
                },
            },
        },
    } as JsonValue;
}

function childTemplateSchema(): JsonValue {
    return {
        type: 'object',
        title: 'Child Agent',
        advancedProperties: [
            'systemPromptId', 'contextSource', 'includeParentSystemPrompt',
            'includeToolResults', 'connectionId', 'modelName', 'toolIds',
            'skillIds', 'approval', 'workingDirectory',
        ],
        properties: {
            agentId: { type: 'string', title: 'Agent' },
            instruction: { type: 'string', title: 'Child task instruction' },
            systemPromptId: { type: 'string', title: 'System Prompt' },
            contextSource: { ...enumSchema(['session', 'parent', 'upstream', 'isolated']), title: 'Context source', unsetLabel: 'isolated (default)' },
            includeParentSystemPrompt: { type: 'boolean', title: 'Include parent system prompt' },
            includeToolResults: { type: 'boolean', title: 'Include dependency/tool results' },
            connectionId: { type: 'string', title: 'Connection slot' },
            modelName: { type: 'string', title: 'Model' },
            toolIds: { type: 'array', title: 'Tools', items: { type: 'string' } },
            skillIds: { type: 'array', title: 'Skills', items: { type: 'string' } },
            approval: { ...enumSchema(['none', 'external', 'all']), title: 'Tool approval' },
            workingDirectory: { type: 'string', title: 'Working directory' },
        },
    } as JsonValue;
}

function fanoutSchema(): JsonValue {
    return {
        type: 'object',
        title: 'Fan-out limits',
        description: `Defaults: ${DELEGATION_DEFAULTS.maxTasks} tasks, ${DELEGATION_DEFAULTS.maxConcurrency} concurrent, depth ${DELEGATION_DEFAULTS.maxDepth}.`,
        properties: {
            maxTasks: { type: 'integer', title: 'Maximum tasks', unsetLabel: `${DELEGATION_DEFAULTS.maxTasks} (default)` },
            maxConcurrency: { type: 'integer', title: 'Maximum concurrency', unsetLabel: `${DELEGATION_DEFAULTS.maxConcurrency} (default)` },
            maxDepth: { type: 'integer', title: 'Maximum nesting depth', unsetLabel: `${DELEGATION_DEFAULTS.maxDepth} (default)` },
            order: { ...enumSchema(['parallel', 'sequential']), title: 'Execution order', unsetLabel: `${DELEGATION_DEFAULTS.order} (default)` },
        },
    } as JsonValue;
}

function failureSchema(): JsonValue {
    return {
        type: 'object',
        title: 'Failure handling',
        properties: {
            policy: { ...enumSchema(['fail-fast', 'continue', 'retry']), title: 'Policy', unsetLabel: `${DELEGATION_DEFAULTS.failurePolicy} (default)` },
            maxAttempts: { type: 'integer', title: 'Retry attempts', unsetLabel: `${DELEGATION_DEFAULTS.retryAttempts} (default)` },
            backoffMs: { type: 'integer', title: 'Retry backoff (ms)' },
        },
    } as JsonValue;
}

function enumSchema(values: string[]): Record<string, JsonValue> {
    return { type: 'string', enum: values };
}
