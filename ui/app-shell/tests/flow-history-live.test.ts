// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { HistoryView } from '../../llm-ui/src/components/HistoryView';

it('paints a Flow delta before any completion event arrives', async () => {
    vi.stubGlobal('mermaid', { run: async () => {}, initialize() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, { getClientRects: { configurable: true, value: () => [] }, getBoundingClientRect: { configurable: true, value: () => new DOMRect() } });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    const host = document.createElement('div'); document.body.append(host); host.scrollTo = vi.fn();
    const view = new HistoryView(host, {});
    try {
        const root = { id: 'root', executorId: 'root', executorType: 'composite', name: 'Flow', status: 'running', startTime: Date.now(), data: {}, children: [] };
        view.processEvent({ type: 'message:appended', payload: { isExecutionRoot: true, sessionGroup: { id: 'round', role: 'assistant', status: 'running', createdAt: Date.now(), executionRoot: root } } } as never);
        view.processEvent({ type: 'node:appended', payload: { parentId: 'root', node: { ...root, id: 'flow-child', parentId: 'root', name: 'Review', data: { output: '', metaInfo: { flowInteraction: true, parallelGroup: 'batch-1' } } } } } as never);
        for (const [id, parallelGroup] of [['peer', 'batch-1'], ['next-round', 'batch-2'], ['serial', undefined]]) {
            view.processEvent({ type: 'node:appended', payload: { parentId: 'root', node: { ...root, id, parentId: 'root', data: { output: '', metaInfo: { flowInteraction: true, parallelGroup } } } } } as never);
        }
        await vi.waitFor(() => expect(host.querySelectorAll('.llm-ui-flow-window')).toHaveLength(3));
        expect(host.querySelector('.llm-ui-flow-window')?.querySelectorAll('.llm-ui-node')).toHaveLength(2);
        const requests = [{ effectId: 'llm-exchange-1', connectionId: 'default', request: { messages: [{ role: 'user', content: '<debug>' }] } }];
        view.processEvent({ type: 'message:updated', payload: { messageId: 'flow-child', metaInfo: { requests } } } as never);
        const node = host.querySelector('#mount-flow-child')!.closest('.llm-ui-node')!;
        await vi.waitFor(() => expect(node.querySelector('.llm-ui-node__req pre')?.textContent).toContain('<debug>'));
        const req = node.querySelector<HTMLDetailsElement>('.llm-ui-node__req')!;
        expect(req.open).toBe(false);
        expect(req.nextElementSibling?.classList.contains('llm-ui-thought')).toBe(true);
        expect(req.querySelector('debug')).toBeNull();
        view.processEvent({ type: 'message:updated', payload: { messageId: 'flow-child', field: 'thought', delta: 'Live thinking before content' } } as never);
        await vi.waitFor(() => expect(host.querySelector('#mount-flow-child')?.closest('.llm-ui-node')?.querySelector('.llm-ui-thought__content')?.textContent).toContain('Live thinking before content'));
        expect((host.querySelector('#mount-flow-child')?.closest('.llm-ui-node')?.querySelector('.llm-ui-thought') as HTMLElement).style.display).toBe('block');
        expect(host.querySelector('#mount-flow-child')?.textContent).not.toContain('Live thinking before content');
        view.processEvent({ type: 'message:updated', payload: { messageId: 'flow-child', field: 'thought', content: '' } } as never);
        expect(node.querySelector('.llm-ui-thought__content')?.textContent).toBe('');
        expect((node.querySelector('.llm-ui-thought') as HTMLElement).style.display).toBe('none');
        view.processEvent({ type: 'message:updated', payload: { messageId: 'flow-child', field: 'output', delta: 'FIRST live chunk' } } as never);
        await vi.waitFor(() => expect(host.querySelector('#mount-flow-child .mdx-editor-renderer')?.textContent).toContain('FIRST live chunk'), { timeout: 2000 });
        expect(host.querySelector('.llm-ui-node--streaming')).not.toBeNull();
    } finally { view.destroy(); await new Promise(resolve => setTimeout(resolve, 0)); host.remove(); vi.unstubAllGlobals();
        delete (Range.prototype as any).getClientRects; delete (Range.prototype as any).getBoundingClientRect; }
});

it('restores parallel windows and folded request snapshots from persisted nodes', async () => {
    const { SessionRenderer } = await import('../../llm-ui/src/components/history/SessionRenderer');
    const mount = vi.spyOn(SessionRenderer.prototype as any, 'mountNodeEditor').mockImplementation(() => {});
    const host = document.createElement('div'), renderer = new SessionRenderer(host, {});
    const requests = [{ effectId: 'e1', connectionId: 'c', request: { messages: [{ role: 'system', content: 'Saved system prompt' }] } }];
    const root = { id: 'r', executorId: 'r', executorType: 'composite', name: 'Flow', status: 'success', startTime: 1, data: {}, children: [] };
    const children = ['a', 'b', 'c'].map((id, index) => ({ ...root, id, parentId: 'r', data: { thought: 'Saved thought', output: 'Saved output',
        metaInfo: { flowInteraction: true, parallelGroup: index < 2 ? 'batch' : undefined, requests } } }));
    try {
        renderer.appendSession({ id: 'round', role: 'assistant', executionRoot: root } as never, false);
        renderer.renderExecutionTree({ ...root, children } as never, false);
        expect(host.querySelectorAll('.llm-ui-flow-window')).toHaveLength(2);
        expect(host.querySelectorAll('.llm-ui-node__req')).toHaveLength(3);
        expect([...host.querySelectorAll<HTMLDetailsElement>('.llm-ui-node__req')].every(panel => !panel.open && panel.textContent?.includes('Saved system prompt'))).toBe(true);
    } finally { renderer.destroy(); mount.mockRestore(); }
});
