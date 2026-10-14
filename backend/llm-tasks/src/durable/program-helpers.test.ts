import { describe, expect, it } from 'vitest';
import type { TaskInputEvent } from '@itookit/durable-kernel';
import { applyDependencyMessages, dependencyOutput, llmEffect, type DurableDependencyBinding } from './program-helpers';
import { collectDependency } from './dependency-collector';

describe('dependencyOutput', () => {
    it('extracts message.content from an agent envelope instead of the whole output', () => {
        const event = exited({
            message: { role: 'assistant', content: 'analysis text' },
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            finishReason: 'stop',
            exchanges: 2,
        });
        const bindings: DurableDependencyBinding[] = [
            { taskId: 'upstream', input: 'analysis', output: 'result' },
        ];

        expect(dependencyOutput(event, bindings)).toEqual({
            taskId: 'upstream',
            key: 'analysis',
            value: 'analysis text',
        });
    });

    it('prefers the declared output artifact content for flow.value envelopes', () => {
        const event = exited({
            outputs: { result: { outputName: 'result', type: 'text', content: 'reduced' } },
        });
        const bindings: DurableDependencyBinding[] = [
            { taskId: 'upstream', input: 'input', output: 'result' },
        ];

        expect(dependencyOutput(event, bindings)).toEqual({
            taskId: 'upstream',
            key: 'input',
            value: 'reduced',
        });
    });

    it('falls back to the raw output when it has no message or matching artifact', () => {
        const event = exited('plain-text');
        const bindings: DurableDependencyBinding[] = [{ taskId: 'upstream', input: 'input' }];

        expect(dependencyOutput(event, bindings)).toEqual({
            taskId: 'upstream',
            key: 'input',
            value: 'plain-text',
        });
    });

    it('returns undefined for non task-exited events', () => {
        expect(dependencyOutput({ type: 'started' }, [])).toBeUndefined();
    });
});

describe('applyDependencyMessages', () => {
    it('can keep scheduling dependencies without injecting their output', () => {
        const messages = [{ role: 'system' as const, content: 'isolated child' }];
        expect(applyDependencyMessages({
            sessionId: 's', roundId: 'r', connectionId: 'default', messages,
            includeDependencyOutputs: false,
        }, { parent: 'secret parent output' })).toEqual(messages);
    });

    it('includes every output supplied by the dependency collector', () => {
        expect(applyDependencyMessages({
            sessionId: 's', roundId: 'r', connectionId: 'default',
            messages: [{ role: 'user', content: 'task' }],
        }, {
            upstream: 'visible result',
        })).toEqual([
            { role: 'user', content: 'task' },
            { role: 'user', content: 'upstream: visible result' },
        ]);
    });
});

describe('collectDependency', () => {
    it('resolves a control dependency without exposing its output', () => {
        const outputs = {};
        const resolved: string[] = [];
        collectDependency([
            { taskId: 'upstream', input: 'control', injectOutput: false },
        ], outputs, resolved, exited('internal result'));

        expect(resolved).toEqual(['upstream']);
        expect(outputs).toEqual({});
    });
});

function exited(output: unknown): TaskInputEvent {
    return {
        type: 'task-exited',
        taskId: 'upstream',
        exit: { taskId: 'upstream', status: 'succeeded', output, completedAt: 1 },
    };
}

it.each([undefined, { retries: 0, backoffMs: 0 }, { retries: 3, backoffMs: 5 }, { retries: 8, backoffMs: 12 }])(
    'builds an explicit durable LLM retry policy %s', llmRetry => {
        const action = llmEffect({ sessionId: 's', roundId: 'r', connectionId: 'c', messages: [], llmRetry }, [], 'h');
        expect(action).toMatchObject({ type: 'effect', effect: {
            retry: { maxAttempts: (llmRetry?.retries ?? 3) + 1, backoffMs: llmRetry?.backoffMs ?? 1000 },
            request: { request: { _maxAttempts: 1 } },
        } });
    });

it.each([{ retries: -1 }, { retries: Number.MAX_SAFE_INTEGER }, { retries: 1.5 }, { backoffMs: -1 }])(
    'rejects invalid llmRetry %s', llmRetry => {
        expect(() => llmEffect({ sessionId: 's', roundId: 'r', connectionId: 'c', messages: [], llmRetry }, [], 'h'))
            .toThrow('Invalid llmRetry');
    });
