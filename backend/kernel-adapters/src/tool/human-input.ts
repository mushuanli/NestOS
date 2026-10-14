// @file: kernel-adapters/src/tool/human-input.ts
import type { ToolDefinition, ToolMeta } from '@itookit/tools/contracts';

export const humanInputMeta: ToolMeta = {
    id: 'human_input',
    name: 'human_input',
    description: 'Request human input when a decision requires human judgement',
    sideEffect: 'none',
    timeoutMs: 86_400_000, // 24h — human may take time
    type: 'builtin',
    enabled: true,
};

export const humanInputDefinition: ToolDefinition = {
    type: 'function',
    function: {
        name: 'human_input',
        description:
            'Request human input when you cannot proceed without a decision that requires human judgement. ' +
            'Execution pauses until the human responds. Provide all context needed for an informed decision.',
        parameters: {
            type: 'object',
            properties: {
                mission_id: {
                    type: 'string',
                    description: 'Mission ID if running inside a mission, otherwise use "default"',
                },
                todo_id: {
                    type: 'string',
                    description: 'Todo ID if running inside a mission, otherwise use "task-1"',
                },
                context: {
                    type: 'string',
                    description: 'Full context: what has been done so far, what is known, why human input is needed',
                },
                question: {
                    type: 'string',
                    description: 'The specific question or decision required from the human',
                },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional quick-select choices for the human (shown as buttons in UI)',
                },
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'VFS paths of relevant files for the human to review',
                },
            },
            required: ['mission_id', 'todo_id', 'context', 'question'],
        },
    },
};
