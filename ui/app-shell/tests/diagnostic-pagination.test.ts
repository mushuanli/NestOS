// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {getLogger, t} from '@itookit/common';
import type {ApplicationDiagnostics, DiagnosticEvent, DiagnosticQuery} from '@itookit/app-contracts/services';
import {DiagnosticLogView} from '../../app-settings/src/editors/log/DiagnosticLogView';

const cleanup: Array<() => void> = [];
afterEach(() => {for (const close of cleanup.splice(0)) close(); document.body.replaceChildren(); vi.restoreAllMocks();});
async function fixture() {
    const events: DiagnosticEvent[] = Array.from({length: 45}, (_, index) => ({id: 'event-' + index, operationId: 'op-' + index,
        timestamp: index + 1000, module: 'application', operation: 'test', stage: 'query', result: 'failure', level: index % 2 ? 'error' : 'warn', code: 'EVENT_' + index}));
    let changed: (() => void) | undefined;
    const query = vi.fn(async (input: DiagnosticQuery = {}) => {
        const filtered = events.filter(event => (!input.search || event.code?.includes(input.search)) && (!input.level || event.level === input.level));
        const offset = Math.min(input.offset ?? 0, Math.max(0, Math.ceil(filtered.length / 20) - 1) * 20);
        return {events: filtered.slice(offset, offset + 20), offset, limit: 20, retained: events.length, matchingGroups: filtered.length,
            truncated: offset + 20 < filtered.length, persistence: 'ready' as const};
    });
    const port: ApplicationDiagnostics = {query, onChange: listener => {changed = listener; return () => {};}};
    const root = document.createElement('div'); document.body.append(root);
    const view = new DiagnosticLogView(root, port); cleanup.push(() => view.destroy()); await view.init();
    const previous = root.querySelector<HTMLButtonElement>('.diagnostic-log__pagination button:first-child')!;
    const next = root.querySelector<HTMLButtonElement>('.diagnostic-log__pagination button:last-child')!;
    return {root, view, query, events, previous, next, changed: () => changed?.(), rows: () => root.querySelectorAll('[data-event-id]')};
}
it('shows twenty groups per page, retains the page on refresh and resets it for changed filters', async () => {
    const f = await fixture(); expect(f.rows()).toHaveLength(20); expect(f.previous.disabled).toBe(true);
    expect(f.root.textContent).toContain(t('diagnostics.pageInfo', {page: 1, pages: 3, groups: 45, size: 20}));
    f.next.click(); await vi.waitFor(() => expect(f.rows()[0].getAttribute('data-event-id')).toBe('event-20'));
    f.root.querySelector('details')!.open = true; await f.view.refresh();
    expect(f.root.querySelector('details')!.open).toBe(true); expect(f.query).toHaveBeenLastCalledWith(expect.objectContaining({offset: 20, limit: 20}));
    f.next.click(); await vi.waitFor(() => expect(f.rows()).toHaveLength(5)); expect(f.next.disabled).toBe(true);
    f.previous.click(); await vi.waitFor(() => expect(f.rows()).toHaveLength(20));
    const search = f.root.querySelector('input')!; search.value = 'EVENT_4'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.rows()).toHaveLength(6)); expect(f.previous.disabled).toBe(true); expect(f.next.disabled).toBe(true);
    const level = f.root.querySelector('select')!; level.value = 'error'; level.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.rows()).toHaveLength(2));
    search.value = 'absent'; search.dispatchEvent(new Event('input')); await vi.waitFor(() => expect(f.rows()).toHaveLength(0));
    expect(f.root.textContent).toContain(t('diagnostics.empty')); expect(f.previous.disabled && f.next.disabled).toBe(true);
});
it('keeps the current page on failed reads and logs safe failure metadata', async () => {
    const f = await fixture(); getLogger().clear();
    f.query.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'}));
    f.next.click(); await vi.waitFor(() => expect(f.root.textContent).toContain(t('diagnostics.readFailed', {code: 'EIO'})));
    expect(f.rows()[0].getAttribute('data-event-id')).toBe('event-0'); expect(f.previous.disabled).toBe(true);
    const logs = getLogger().query({modules: ['diagnostic-log-view']});
    expect(logs).toContainEqual(expect.objectContaining({data: expect.objectContaining({operationId: expect.any(String), result: 'failure', code: 'EIO', durationMs: expect.any(Number)})}));
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_BODY');
    f.next.click(); await vi.waitFor(() => expect(f.rows()[0].getAttribute('data-event-id')).toBe('event-20'));
});

it('keeps single operation summaries concise and copies only the visible page', async () => {
    const f = await fixture(), copy = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: copy}});
    f.events[0].startedAt = 900; f.events[0].durationMs = 100;
    f.events[0].series = {count: 1, firstAt: 1000, lastAt: 1000, firstOperationId: 'op-0', samples: [], minDurationMs: 100, maxDurationMs: 100};
    await f.view.refresh();
    const summary = f.root.querySelector('.diagnostic-log__series')!;
    expect(summary.textContent).toContain(t('diagnostics.startedAt'));
    expect(summary.textContent).not.toContain(t('diagnostics.occurrences', {count: 1}));
    expect(summary.textContent).not.toContain(t('diagnostics.durationRange'));
    [...f.root.querySelectorAll('button')].find(button => button.textContent === t('diagnostics.copy'))!.click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(JSON.parse(copy.mock.calls[0][0])).toHaveLength(20);
});
