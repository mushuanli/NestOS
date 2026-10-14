// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createMDxEditor } from '@itookit/mdx-adapter';
import { HistoryView } from '../../llm-ui/src/components/HistoryView';
import { SessionRenderer } from '../../llm-ui/src/components/history/SessionRenderer';
vi.mock('@itookit/mdx-adapter', () => ({ createMDxEditor: vi.fn(async () => ({
    on() {}, destroy() {}, getMode: () => 'render', collapseBlocks: async () => ({ affectedCount: 0, allCollapsed: true }),
})) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('renders only expanded Markdown, preserves copy, and activates single/all expansions', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    const host = document.createElement('div'); document.body.append(host); host.scrollTo = vi.fn();
    const view = new HistoryView(host, {});
    const sessions = Array.from({ length: 2 }, (_, i) => [
        { id: `u${i}`, role: 'user', content: `question ${i}` },
        { id: `a${i}`, role: 'assistant', executionRoot: { id: `n${i}`, name: 'Reply', executorId: 'agent', executorType: 'llm',
            status: 'success', startTime: 1, data: { output: `answer ${i}` }, children: [] } },
    ]).flat();
    try {
        view.renderFull(sessions as never);
        expect(createMDxEditor).toHaveBeenCalledTimes(1);
        const renderer = (view as unknown as { renderer: SessionRenderer }).renderer;
        expect(renderer.copyContent('u0')).toBe('question 0');
        expect(renderer.copyContent('n0')).toBe('answer 0');
        expect(createMDxEditor).toHaveBeenCalledTimes(1);
        view.toggleSessionCollapse('u0', false);
        expect(createMDxEditor).toHaveBeenCalledTimes(2);
        view.setAllCollapsed(false);
        expect(createMDxEditor).toHaveBeenCalledTimes(4);
        view.setAllCollapsed(true); view.setAllCollapsed(false);
        expect(createMDxEditor).toHaveBeenCalledTimes(4);
        await Promise.resolve();
    } finally { view.destroy(); }
});
