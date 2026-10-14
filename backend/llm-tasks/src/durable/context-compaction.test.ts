import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@itookit/llm-context';
import { compactMessages } from '@itookit/llm-context';
import { DurableAgentProgram } from './agent-program';
import { ProviderMessageAdapter } from '@itookit/llm-context';

const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'inspect', arguments: '{}' } });

describe('durable context compaction', () => {
    it('refreshes only declared Skill tools and requires approval for newly loaded external tools', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'external',
            messages: [{ role: 'user', content: 'task' }], allowedToolIds: ['load_skill', 'publish'],
            tools: [{ name: 'load_skill' }] });
        const started = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const loading = program.reduce(started.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
            result: { choices: [{ message: { role: 'assistant', content: null,
                tool_calls: [{ ...call('load'), function: { name: 'load_skill', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] } });
        const loaded = program.reduce(loading.state, { type: 'effect-completed', effectId: 'tool-load', result: {
            toolId: 'load_skill', success: true, output: 'loaded', durationMs: 1,
            skillContext: { skillId: 'review', compactInstructions: '', tools: [
                { toolId: 'publish', definition: { name: 'publish' }, external: true },
                { toolId: 'unrelated', definition: { name: 'unrelated' }, external: false },
                { toolId: 'load_skill', definition: { name: 'load_skill', description: 'replacement' }, external: false },
            ] },
        } });
        const effect = loaded.actions?.find(action => action.type === 'effect');
        if (effect?.type !== 'effect') throw new Error('LLM effect missing');
        expect(effect.effect.request).toMatchObject({ request: { tools: [{ name: 'load_skill' }, { name: 'publish' }] } });
        const publish = program.reduce(JSON.parse(JSON.stringify(loaded.state)), {
            type: 'effect-completed', effectId: 'llm-exchange-2', result: { choices: [{ message: { role: 'assistant', content: null,
                tool_calls: [{ ...call('publish-call'), function: { name: 'publish', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
        });
        expect(publish.state.phase).toBe('approval');
        expect(publish.actions?.some(action => action.type === 'effect')).toBe(false);
        expect(publish.next).toEqual({ type: 'wait', on: { type: 'interaction', id: 'approval:2:publish-call' } });
        const legacy = JSON.parse(JSON.stringify(loaded.state));
        delete legacy.input.allowedToolIds;
        legacy.phase = 'human';
        const resumed = program.reduce(legacy, { type: 'interaction-resolved', interactionId: 'human', value: 'continue' });
        const legacyEffect = resumed.actions?.find(action => action.type === 'effect');
        if (legacyEffect?.type !== 'effect') throw new Error('LLM effect missing');
        expect(legacyEffect.effect.request).toMatchObject({ request: { tools: [{ name: 'load_skill' }] } });
    });

    it('activates initially selected Skills without a load_skill call', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'none',
            messages: [{ role: 'user', content: 'task' }], allowedToolIds: ['publish'],
            tools: [{ name: 'task-tool' }],
            skillContexts: [{ skillId: 'review', compactInstructions: 'Keep access checks.',
                tools: [{ toolId: 'publish', definition: { name: 'publish' }, external: false },
                    { toolId: 'unrelated', definition: { name: 'unrelated' }, external: false }] }] });
        expect(initial.state.skillContexts).toEqual([{ skillId: 'review', compactInstructions: 'Keep access checks.',
            tools: [{ toolId: 'publish', definition: { name: 'publish' }, external: false },
                { toolId: 'unrelated', definition: { name: 'unrelated' }, external: false }] }]);
        const started = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const request = started.actions?.find(action => action.type === 'effect');
        if (request?.type !== 'effect') throw new Error('LLM effect missing');
        // Allowed Skill tools are exposed immediately; the critical rules ride along.
        expect(request.effect.request).toMatchObject({ request: { tools: [{ name: 'task-tool' }, { name: 'publish' }] } });
        expect(JSON.stringify(request.effect.request)).toContain('Keep access checks.');
        // Compacting the message window keeps the activation independent of tool history.
        const compacted = compactMessages([{ role: 'system', content: 'Keep access checks.' },
            { role: 'user', content: 'task' }], { maxMessages: 2, keepRecent: 1 });
        expect(compacted.some(message => message.content === 'Keep access checks.')).toBe(true);
    });

    it('requires approval before a dynamically loaded external tool in the same assistant batch', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'external',
            messages: [{ role: 'user', content: 'task' }], allowedToolIds: ['load_skill', 'publish'],
            tools: [{ name: 'load_skill' }] });
        const started = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const loading = program.reduce(started.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
            result: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { ...call('load'), function: { name: 'load_skill', arguments: '{}' } },
                { ...call('publish-call'), function: { name: 'publish', arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] } });
        const loadEffect = loading.actions?.find(action => action.type === 'effect');
        if (loadEffect?.type !== 'effect') throw new Error('load_skill effect missing');
        expect(loadEffect.effect.request).toMatchObject({ toolId: 'load_skill' });

        const loaded = program.reduce(JSON.parse(JSON.stringify(loading.state)), {
            type: 'effect-completed', effectId: 'tool-load', result: {
                toolId: 'load_skill', success: true, output: 'loaded', durationMs: 1,
                skillContext: { skillId: 'review', compactInstructions: '', tools: [
                    { toolId: 'publish', definition: { name: 'publish' }, external: true },
                ] },
            },
        });
        expect(loaded.state.phase).toBe('approval');
        expect(loaded.actions?.some(action => action.type === 'effect')).toBe(false);
        expect(loaded.next).toEqual({ type: 'wait', on: { type: 'interaction', id: 'approval:1:publish-call' } });
        const approval = loaded.actions?.find(action => action.type === 'request-interaction');
        if (approval?.type !== 'request-interaction') throw new Error('approval interaction missing');
        expect(approval.interaction.payload).toMatchObject({ callId: 'publish-call', calls: [{ tool: 'publish' }] });

        // Checkpoint restore preserves the pending approval, then approval dispatches the tool.
        const approved = program.reduce(JSON.parse(JSON.stringify(loaded.state)), {
            type: 'interaction-resolved', interactionId: 'approval:1:publish-call', value: { approved: true },
        });
        expect(approved.state.approvedCallKeys).toHaveLength(1);
        const publishEffect = approved.actions?.find(action => action.type === 'effect');
        if (publishEffect?.type !== 'effect') throw new Error('publish effect missing');
        expect(publishEffect.effect.request).toMatchObject({ toolId: 'publish' });
        expect(approved.next).toEqual({ type: 'wait', on: { type: 'effect', id: 'tool-1-publish-call' } });

        // Rejection only rejects unexecuted calls and keeps the completed load_skill result.
        const rejected = program.reduce(JSON.parse(JSON.stringify(loaded.state)), {
            type: 'interaction-resolved', interactionId: 'approval:1:publish-call', value: { approved: false },
        });
        expect(rejected.state.phase).toBe('llm');
        expect(rejected.actions?.some(action => action.type === 'effect' && action.effect.kind === 'tool.call')).toBe(false);
        expect(rejected.state.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'load')).toHaveLength(1);
        expect(rejected.state.messages).toContainEqual(expect.objectContaining({
            role: 'tool', tool_call_id: 'publish-call', content: 'Tool execution was not authorized',
        }));
    });

    it('rejects empty and duplicate tool call ids before dispatching any tool effect', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'all',
            messages: [{ role: 'user', content: 'task' }], tools: [{ name: 'read' }, { name: 'publish' }] });
        const started = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const duplicate = program.reduce(started.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
            result: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { ...call('same'), function: { name: 'read', arguments: '{}' } },
                { ...call('same'), function: { name: 'publish', arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] } });
        expect(duplicate.next).toEqual({ type: 'fail', error: { message: 'Duplicate tool call id: same', code: 'INVALID_TOOL_CALLS' } });
        expect(duplicate.actions ?? []).toEqual([]);

        const empty = program.reduce(started.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
            result: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { ...call(''), function: { name: 'read', arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] } });
        expect(empty.next).toEqual({ type: 'fail', error: { message: 'Tool call id is required', code: 'INVALID_TOOL_CALLS' } });
        expect(empty.actions ?? []).toEqual([]);
    });

    it('does not inherit approval for a later exchange that reuses the same call id', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'all',
            messages: [{ role: 'user', content: 'task' }], tools: [{ name: 'read' }, { name: 'publish' }] });
        const started = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const firstRequest = program.reduce(started.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
            result: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { ...call('call-1'), function: { name: 'read', arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] } });
        expect(firstRequest.state.phase).toBe('approval');
        const firstApproved = program.reduce(JSON.parse(JSON.stringify(firstRequest.state)), {
            type: 'interaction-resolved', interactionId: 'approval:1:call-1', value: { approved: true },
        });
        expect(firstApproved.state.approvedCallKeys).toHaveLength(1);
        const firstCompleted = program.reduce(JSON.parse(JSON.stringify(firstApproved.state)), {
            type: 'effect-completed', effectId: 'tool-1-call-1',
            result: { toolId: 'read', success: true, output: 'first', durationMs: 1 },
        });
        expect(firstCompleted.state.phase).toBe('llm');

        const secondRequest = program.reduce(JSON.parse(JSON.stringify(firstCompleted.state)), {
            type: 'effect-completed', effectId: 'llm-exchange-2',
            result: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { ...call('call-1'), function: { name: 'publish', arguments: '{"target":"outside"}' } },
            ] }, finish_reason: 'tool_calls' }] },
        });
        expect(secondRequest.state.phase).toBe('approval');
        expect(secondRequest.actions?.some(action => action.type === 'effect' && action.effect.kind === 'tool.call')).toBe(false);
        expect(secondRequest.next).toEqual({ type: 'wait', on: { type: 'interaction', id: 'approval:2:call-1' } });
    });

    it('accepts legacy call.id approval interactions and migrates the state', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'external',
            messages: [{ role: 'user', content: 'task' }], allowedToolIds: ['load_skill', 'publish'],
            tools: [{ name: 'load_skill' }] });
        const started = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const loading = program.reduce(started.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
            result: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { ...call('load'), function: { name: 'load_skill', arguments: '{}' } },
                { ...call('publish-call'), function: { name: 'publish', arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] } });
        const loaded = program.reduce(loading.state, {
            type: 'effect-completed', effectId: 'tool-load', result: {
                toolId: 'load_skill', success: true, output: 'loaded', durationMs: 1,
                skillContext: { skillId: 'review', compactInstructions: '', tools: [
                    { toolId: 'publish', definition: { name: 'publish' }, external: true },
                ] },
            },
        });
        expect(loaded.state.phase).toBe('approval');

        const legacy = JSON.parse(JSON.stringify(loaded.state));
        delete legacy.approvedCallKeys;
        delete legacy.approvalProtocol;
        delete legacy.pendingApprovalInteractionId;
        legacy.approvedCallIds = [];

        const approved = program.reduce(legacy, {
            type: 'interaction-resolved', interactionId: 'publish-call', value: { approved: true },
        });
        expect(approved.state.phase).toBe('tool');
        expect(approved.state.approvalProtocol).toBe(2);
        expect(approved.state.approvedCallKeys).toHaveLength(1);
        expect(approved.state.pendingApprovalInteractionId).toBeUndefined();
        const effect = approved.actions?.find(action => action.type === 'effect');
        if (effect?.type !== 'effect') throw new Error('publish effect missing');
        expect(effect.effect.request).toMatchObject({ toolId: 'publish' });

        const legacyRejected = JSON.parse(JSON.stringify(loaded.state));
        delete legacyRejected.approvedCallKeys;
        delete legacyRejected.approvalProtocol;
        delete legacyRejected.pendingApprovalInteractionId;
        legacyRejected.approvedCallIds = [];
        const rejected = program.reduce(legacyRejected, {
            type: 'interaction-resolved', interactionId: 'publish-call', value: { approved: false },
        });
        expect(rejected.state.phase).toBe('llm');
        expect(rejected.state.approvalProtocol).toBe(2);
        expect(rejected.actions?.some(action => action.type === 'effect' && action.effect.kind === 'tool.call')).toBe(false);
        expect(rejected.state.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'load')).toHaveLength(1);
        expect(rejected.state.messages).toContainEqual(expect.objectContaining({
            role: 'tool', tool_call_id: 'publish-call', content: 'Tool execution was not authorized',
        }));
    });

    it('retains Skill critical rules after tool history pruning and checkpoint reload', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', maxExchanges: 10,
            messages: [{ role: 'user', content: 'task' }], contextCompaction: { maxMessages: 3, keepRecent: 1 } });
        let next = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        for (let index = 0; index < 4; index++) {
            const pending = program.reduce(JSON.parse(JSON.stringify(next.state)), {
                type: 'effect-completed', effectId: `llm-exchange-${index + 1}`, result: { choices: [{
                    message: { role: 'assistant', content: null, tool_calls: [call(`call-${index}`)] }, finish_reason: 'tool_calls',
                }] },
            });
            next = program.reduce(JSON.parse(JSON.stringify(pending.state)), {
                type: 'effect-completed', effectId: `tool-call-${index}`, result: {
                    toolId: 'inspect', success: true, output: index === 0 ? 'Full skill body' : 'Other output', durationMs: 1,
                    ...(index === 0 ? { skillContext: { skillId: 'review', compactInstructions: 'Keep access checks.' } } : {}),
                },
            });
            const effect = next.actions?.find(action => action.type === 'effect');
            if (effect?.type !== 'effect') throw new Error('LLM effect missing');
            const request = effect.effect.request as unknown as { request: { messages: ChatMessage[] } };
            expect(request.request.messages.filter(message => message.role === 'system')).toEqual([
                { role: 'system', content: 'Skill review — critical rules:\nKeep access checks.' },
            ]);
            new ProviderMessageAdapter().validate(request.request.messages);
        }
        expect(next.state.messages.some(message => message.content === 'Full skill body')).toBe(false);
        expect(next.state.skillContexts).toEqual([{ skillId: 'review', compactInstructions: 'Keep access checks.' }]);
    });

    it('preserves every system instruction and the latest user even beyond the threshold', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'Policy one' }, { role: 'system', content: 'Policy two' },
            { role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'current objective' }, { role: 'assistant', content: 'recent' },
        ];
        expect(compactMessages(messages, { maxMessages: 2, keepRecent: 1 })).toEqual([
            messages[0], messages[1], messages[4], messages[5],
        ]);
        expect(messages).toHaveLength(6);
    });

    it('retains a complete parallel tool group when the cutoff falls inside its results', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'task' }, { role: 'assistant', content: 'old response' },
            { role: 'assistant', content: null, tool_calls: [call('one'), call('two')] },
            { role: 'tool', content: 'first', tool_call_id: 'one' },
            { role: 'tool', content: 'second', tool_call_id: 'two' },
        ];
        const compacted = compactMessages(messages, { maxMessages: 2, keepRecent: 1 });
        expect(compacted).toEqual([messages[0], ...messages.slice(2)]);
        expect(new ProviderMessageAdapter().validate(compacted)).toEqual(compacted);
    });

    it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid compaction threshold %s', maxMessages => {
        const program = new DurableAgentProgram();
        expect(() => program.init({ sessionId: 's', roundId: 'r', connectionId: 'c',
            messages: [{ role: 'user', content: 'task' }], contextCompaction: { maxMessages } })).toThrow('compaction');
    });

    it('compacts every tool exchange and preserves operation identity across checkpoint reloads', () => {
        const program = new DurableAgentProgram();
        const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', maxExchanges: 10,
            messages: [{ role: 'system', content: 'Policy' }, { role: 'user', content: 'task' }],
            contextCompaction: { maxMessages: 4, keepRecent: 1 } });
        let next = program.reduce(initial.state, { type: 'signal', sequence: 1,
            signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tools' } } });
        const ids: string[] = [], keys: string[] = [], lengths: number[] = [];
        for (let index = 0; index < 5; index++) {
            const effect = next.actions?.find(action => action.type === 'effect');
            if (effect?.type !== 'effect') throw new Error('LLM effect missing');
            ids.push(effect.effect.id!);
            keys.push(effect.effect.idempotencyKey!);
            lengths.push(next.state.messages.length);
            expect(next.next).toEqual({ type: 'wait', on: { type: 'effect', id: effect.effect.id } });
            expect(next.state.messages[0].content).toBe('Policy');
            new ProviderMessageAdapter().validate(next.state.messages);
            const pending = program.reduce(JSON.parse(JSON.stringify(next.state)), {
                type: 'effect-completed', effectId: effect.effect.id!, result: { choices: [{
                    message: { role: 'assistant', content: null, tool_calls: [call(`call-${index}`)] }, finish_reason: 'tool_calls',
                }] },
            });
            const event = { type: 'effect-completed' as const, effectId: `tool-call-${index}`,
                result: { toolId: 'inspect', success: true, output: `result-${index}`, durationMs: 1 } };
            next = program.reduce(JSON.parse(JSON.stringify(pending.state)), event);
            expect(program.reduce(JSON.parse(JSON.stringify(pending.state)), event)).toEqual(next);
        }
        expect(new Set(ids).size).toBe(5);
        expect(new Set(keys).size).toBe(5);
        expect(lengths).toEqual([2, 4, 4, 4, 4]);
    });
});
