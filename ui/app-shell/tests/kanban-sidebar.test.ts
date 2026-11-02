// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import type {KanbanBoardSummary, KanbanClient} from '@itookit/kanban/contracts';
import {KanbanSidebar} from '../src/kanban/sidebar';

const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).forEach(close => close()); document.body.replaceChildren();});
const board = (id: string): KanbanBoardSummary => ({id, title: id, number: 1, items: []} as unknown as KanbanBoardSummary);
async function fixture() {
    const catalog = vi.fn(async () => [board('Initial')]), report = vi.fn(), navigate = vi.fn(async () => {});
    const container = document.createElement('aside'); document.body.append(container);
    const sidebar = new KanbanSidebar({container, service: {catalog} as unknown as KanbanClient, navigate, create: vi.fn(), lookup: vi.fn(), report});
    cleanups.push(() => sidebar.destroy()); await sidebar.start();
    return {sidebar, container, catalog, report, navigate};
}
it('retains the list and safe error cause after failure, then retries and refreshes it', async () => {
    const f = await fixture(); f.catalog.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'}));
    f.sidebar.invalidate();
    await vi.waitFor(() => expect(f.container.querySelector('[role=alert]')!.textContent).toBe(t('kanban.errors.EIO')));
    expect(f.container.textContent).toContain('Initial'); expect(f.container.textContent).not.toContain('PRIVATE_BODY');
    f.catalog.mockResolvedValue([board('Recovered')]); f.sidebar.invalidate();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Recovered'), {timeout: 2500});
    expect(f.container.querySelector<HTMLElement>('[role=alert]')!.hidden).toBe(true);
});
it('coalesces hidden changes and discards a response that arrives after destruction', async () => {
    const f = await fixture(); f.sidebar.setVisible(false); f.catalog.mockClear();
    f.sidebar.invalidate(); f.sidebar.invalidate(); await new Promise(resolve => setTimeout(resolve, 150)); expect(f.catalog).not.toHaveBeenCalled();
    f.sidebar.setVisible(true); await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(1));
    let finish!: (boards: KanbanBoardSummary[]) => void;
    f.catalog.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})); f.sidebar.invalidate();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); f.sidebar.destroy(); finish([board('Late')]);
    await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).toBe(''); expect(f.report).not.toHaveBeenCalled();
});
