// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@itookit/ui-common', async () => ({ ...await vi.importActual('@itookit/ui-common'), copyText: vi.fn(async () => {}) }));
import { copyText } from '@itookit/ui-common';
import { HistoryView } from '../../llm-ui/src/components/HistoryView';
import { SessionRenderer } from '../../llm-ui/src/components/history/SessionRenderer';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('routes roots to the latest assistant and recovers after removing or clearing that assistant', () => {
    vi.spyOn(SessionRenderer.prototype as any, 'mountNodeEditor').mockImplementation(() => {});
    const host = document.createElement('div'), renderer = new SessionRenderer(host, {});
    const append = (id: string) => renderer.appendNode(undefined, {
        id, executorId: id, executorType: 'composite', name: id, status: 'success', startTime: 1, data: {}, children: [],
    }, false);
    try {
        renderer.appendSession({ id: 'a', role: 'assistant' } as never, false);
        append('first');
        renderer.appendSession({ id: 'b', role: 'assistant' } as never, false);
        append('second');
        expect(renderer.getNode('first')?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId).toBe('a');
        expect(renderer.getNode('second')?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId).toBe('b');
        renderer.removeMessages(['b'], false);
        append('after-delete');
        expect(renderer.getNode('after-delete')?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId).toBe('a');
        renderer.clear();
        renderer.appendSession({ id: 'c', role: 'assistant' } as never, false);
        append('after-clear');
        expect(renderer.getNode('after-clear')?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId).toBe('c');
    } finally { renderer.destroy(); }
});

it('supports window/node copy, independent folding, global fold and restored fold states', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.spyOn(SessionRenderer.prototype as any, 'mountNodeEditor').mockImplementation(() => {});
    const host = document.createElement('div'); document.body.append(host); host.scrollTo = vi.fn();
    const view = new HistoryView(host, {});
    const root = { id: 'r', executorId: 'r', executorType: 'composite', name: 'Flow', status: 'success', startTime: 1, data: {}, children: [] };
    const children = ['a', 'b'].map(id => ({ ...root, id, executorId: id, name: id, parentId: 'r', messageRole: 'assistant',
        data: { output: `Answer ${id}`, metaInfo: { flowInteraction: true, parallelGroup: 'batch' } } }));
    const sessions = [{ id: 'round', role: 'assistant', executionRoot: { ...root, children } }];
    try {
        view.renderFull(sessions as never);
        const renderer = (view as any).renderer as SessionRenderer;
        for (const id of ['a', 'b']) renderer.editors.set(id, { content: `Answer ${id}`, destroy() {} } as never);
        const window = host.querySelector<HTMLElement>('.llm-ui-flow-window')!;
        const header = window.querySelector('.llm-ui-node__header')!;
        const first = renderer.getNode('a')!;
        expect(header.textContent).toContain('a · b');
        first.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
        expect(copyText).toHaveBeenLastCalledWith('Answer a');
        header.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
        expect(copyText).toHaveBeenLastCalledWith('## a\n\nAnswer a\n\n## b\n\nAnswer b');
        first.querySelector<HTMLButtonElement>('[data-action="collapse"]')!.click();
        expect(first.classList.contains('is-collapsed')).toBe(true);
        expect(renderer.getNode('b')!.classList.contains('is-collapsed')).toBe(false);
        expect(view.getCollapseStates().a).toBe(true);
        header.querySelector<HTMLButtonElement>('[data-action="collapse"]')!.click();
        expect(window.classList.contains('is-collapsed')).toBe(true);
        expect(view.getCollapseStates()[window.dataset.historyId!]).toBe(true);
        view.setAllCollapsed(false);
        expect(window.classList.contains('is-collapsed')).toBe(false);
        view.setAllCollapsed(true);
        expect(first.classList.contains('is-collapsed')).toBe(true);
        view.renderFull(sessions as never);
        expect(host.querySelector('.llm-ui-flow-window')!.classList.contains('is-collapsed')).toBe(true);
        expect(renderer.getNode('b')!.classList.contains('is-collapsed')).toBe(true);
        view.setAllCollapsed(false);
        expect(view.getUnfoldedNavigationTarget('next')).not.toBeNull();
    } finally { view.destroy(); host.remove(); }
});
