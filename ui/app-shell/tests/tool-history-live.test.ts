// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { HistoryView } from '../../llm-ui/src/components/HistoryView';
import { SessionRenderer } from '../../llm-ui/src/components/history/SessionRenderer';
import { NodeRenderer } from '../../llm-ui/src/components/history/NodeRenderer';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('shows the invocation and running state before results, then renders multiline output safely', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(SessionRenderer.prototype as any, 'mountNodeEditor').mockImplementation(() => {});
    const host = document.createElement('div'); document.body.append(host); host.scrollTo = vi.fn();
    const view = new HistoryView(host, {});
    const root = { id: 'root', executorId: 'default', executorType: 'agent', name: 'Assistant', status: 'running', startTime: 1, data: {}, children: [] };
    const tool = { ...root, id: 'grep', parentId: 'root', executorId: 'Grep', executorType: 'tool', name: 'Grep',
        data: { input: { pattern: '<mdx>' }, output: '' } };
    const call = { toolId: 'grep', name: 'Grep', input: tool.data.input };
    try {
        view.processEvent({ type: 'message:appended', payload: { isExecutionRoot: true,
            sessionGroup: { id: 'round', role: 'assistant', executionRoot: root } } } as never);
        view.processEvent({ type: 'node:appended', payload: { parentId: 'root', node: tool } } as never);
        view.processEvent({ type: 'tool:running', payload: { call } } as never);
        const card = host.querySelector<HTMLElement>('[data-id="grep"]')!;
        expect(card.dataset.status).toBe('running');
        expect(card.closest('.is-collapsed')).toBeNull();
        expect(card.querySelector('.llm-ui-node__input pre')?.textContent).toContain('<mdx>');
        const result = card.querySelector<HTMLElement>('.llm-ui-node__result')!;
        expect(result.style.display).toBe('none');
        view.processEvent({ type: 'tool:progress', payload: { call: { ...call,
            progress: { message: 'cwd: /workspace; scanned: 1', output: '/workspace/a.ts:1: <mdx>' } } } } as never);
        expect(card.dataset.status).toBe('running');
        expect(card.querySelector<HTMLElement>('.llm-ui-node__progress')!.hidden).toBe(false);
        expect(result.textContent).toContain('/workspace/a.ts:1: <mdx>');
        const output = '/workspace/a.ts:1: <mdx>\n/workspace/b.ts:2: mdx';
        view.processEvent({ type: 'tool:success', payload: { call: { ...call, result: output } } } as never);
        expect(card.dataset.status).toBe('success'); expect(result.style.display).toBe('block');
        expect(card.querySelector<HTMLElement>('.llm-ui-node__progress')!.hidden).toBe(true);
        view.processEvent({ type: 'tool:progress', payload: { call: { ...call,
            progress: { message: 'stale', output: 'stale' } } } } as never);
        expect(result.textContent).toBe(output); expect(card.querySelector('mdx')).toBeNull();
        view.processEvent({ type: 'tool:success', payload: { call: { ...call, result: '' } } } as never);
        expect(result.textContent).toBe('');
        view.processEvent({ type: 'tool:error', payload: { call: { ...call, error: 'Tool execution timed out' } } } as never);
        expect(card.dataset.status).toBe('failed'); expect(result.textContent).toBe('Tool execution timed out');
    } finally { view.destroy(); }
});

it('restores a failed tool with its persisted error and arguments', () => {
    const { element } = NodeRenderer.create({ id: 'grep', executorType: 'tool', name: 'Grep', status: 'failed',
        startTime: 1, data: { input: { pattern: 'mdx' }, error: '<error> timeout', output: '' } } as never);
    expect(element.querySelector('.llm-ui-node__result')?.textContent).toBe('<error> timeout');
    expect(element.querySelector('error')).toBeNull();
});
