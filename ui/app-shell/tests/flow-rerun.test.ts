// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionCommand } from '@itookit/llm-session';
import { rerunSessionFlow } from '../../llm-ui/src/flows/rerun-flow';
import { NodeRenderer } from '../../llm-ui/src/components/history/NodeRenderer';
import { EventBatchProcessor } from '../../llm-ui/src/components/common/EventBatchProcessor';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

it('prefills branch parameters, submits the source identity and cancels without creating a branch', async () => {
    const execute = vi.fn(async (command: string) => command === SessionCommand.GetConnections ? { connections: [] } : command === SessionCommand.FlowRerunContext
        ? { sessionId: 's', definitionKey: 'draft-key', sourceRoundId: 'r', flow: { parameters: { essay: 'previous' } }, definition: { parameters: [{ name: 'essay', type: 'string', required: true }] } }
        : { branchName: 'branch-1' });
    const first = rerunSessionFlow({ execute } as never, new AbortController().signal);
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe('previous'));
    (document.querySelector('[data-cancel]') as HTMLButtonElement).click(); await first;
    expect(execute).toHaveBeenCalledTimes(2);
    const second = rerunSessionFlow({ execute } as never, new AbortController().signal);
    await vi.waitFor(() => expect(document.querySelector('textarea')).not.toBeNull());
    document.querySelector('textarea')!.value = 'new';
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await second;
    expect(execute).toHaveBeenLastCalledWith(SessionCommand.FlowRerun, { parameters: { essay: 'new' }, sourceRoundId: 'r', sessionId: 's', definitionKey: 'draft-key', connectionId: undefined });
});

it('renders interaction roles without logical node controls and flushes deltas before final replacement', () => {
    const node = { id: 'node', executorId: 'task', executorType: 'composite', name: '<check>', messageRole: 'assistant',
        status: 'running', startTime: 1, data: {}, children: [] };
    const rendered = NodeRenderer.create(node as never).element;
    expect(rendered.dataset.role).toBe('assistant');
    expect(rendered.textContent).toContain('<check>');
    expect(rendered.querySelector('[data-action="regenerate"]')).toBeNull();
    const events: string[] = [];
    const batch = new EventBatchProcessor<any>(value => events.push(value.chunks.get('node')!.output), value => events.push(value.payload.content));
    batch.push({ type: 'message:updated', payload: { messageId: 'node', field: 'output', delta: 'partial' } });
    batch.push({ type: 'message:updated', payload: { messageId: 'node', field: 'output', content: 'complete' } });
    expect(events).toEqual(['partial', 'complete']);
});

it('renders tool provenance separately from the assistant role and escapes identity labels', () => {
    const node = { id: 'tool', executorId: 'task', executorType: 'composite', name: 'lookup', messageRole: 'assistant',
        status: 'success', startTime: 1, data: { input: { essay: 'sample' }, output: 'rubric',
            metaInfo: { actor: { kind: 'tool', nodeName: '<Check>', agentId: 'reviewer', skillIds: ['review'], toolCallId: 'call:1' } } }, children: [] };
    const rendered = NodeRenderer.create(JSON.parse(JSON.stringify(node))).element;
    expect(rendered.querySelector('[data-actor-kind="tool"]')).not.toBeNull();
    expect(rendered.textContent).toContain('<Check>');
    expect(rendered.textContent).toContain('Skill: review');
    expect(rendered.textContent).toContain('Agent: reviewer');
    expect(rendered.textContent).toContain('call:1');
    expect(rendered.querySelector('check')).toBeNull();
});
