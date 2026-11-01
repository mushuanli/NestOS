// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {parseCalendarEvent, onDay, monthDays} from '../src/calendar/model';
import {readCalendar} from '../src/calendar/read';
import {CalendarWorkbench} from '../src/calendar';

const event = (title = 'Meeting') => ({id: 'same-id', source: {name: 'Other provider'}, summary: title,
    start: {date: '2026-11-01'}, end: {date: '2026-11-03'}});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const files = await manager.openFileSystem('/home/admin/calendar');
    for (const account of ['account-one', 'account-two']) {
        await files.driver.createDirectory({name: account, recursive: true});
        await files.driver.createFile({name: 'event.json', parentPath: '/' + account, content: JSON.stringify(event(account))});
    }
    return {files, manager};
}
it('scopes equal event IDs to separate sources and respects exclusive all-day ends', () => {
    const one = parseCalendarEvent(JSON.stringify(event()), '/one/a.json')!;
    const two = parseCalendarEvent(JSON.stringify(event()), '/two/a.json')!;
    expect(one.id).toBe(two.id); expect(one.key).not.toBe(two.key); expect(one.sourceId).not.toBe(two.sourceId);
    expect(onDay(one, '2026-11-01')).toBe(true); expect(onDay(one, '2026-11-02')).toBe(true); expect(onDay(one, '2026-11-03')).toBe(false);
    expect(monthDays(new Date(2026, 10, 1))).toHaveLength(42);
    expect(monthDays(new Date(2026, 10, 1))[0]).toBe('2026-10-26');
});
it('validates dates and cancelled events without interpreting untrusted HTML', () => {
    expect(parseCalendarEvent(JSON.stringify({id: 'cancelled', status: 'cancelled'}), '/one/a.json')).toBeUndefined();
    expect(() => parseCalendarEvent(JSON.stringify({...event(), start: {date: '2026-02-30'}}), '/a.json')).toThrow('CALENDAR_EVENT_DATES_INVALID');
    expect(() => parseCalendarEvent(JSON.stringify({...event(), start: {dateTime: '2026-11-01T10:00:00'}, end: {dateTime: '2026-11-01T11:00:00'}}), '/a.json')).toThrow();
    const timed = parseCalendarEvent(JSON.stringify({...event(), start: {dateTime: '2026-11-01T00:30:00+08:00'}, end: {dateTime: '2026-11-01T01:00:00+08:00'}}), '/one/a.json')!;
    expect(timed.allDay).toBe(false);
    expect(onDay(timed, new Date(timed.start).toLocaleDateString('sv-SE'))).toBe(true);
});
it('reads multiple providers, preserves empty sources and surfaces invalid material without reading checkpoints', async () => {
    const {files, manager} = await fixture();
    try {
        await files.driver.createFile({name: '.sync.json', parentPath: '/account-one', content: '{private-checkpoint'});
        await files.driver.createDirectory({name: 'empty', recursive: true});
        await files.driver.createFile({name: '.calendar-source.json', parentPath: '/empty', content: JSON.stringify({format: 'nestos.calendar-source', version: 1, name: 'Empty calendar', archivedAt: 1})});
        await files.driver.createFile({name: 'bad.json', parentPath: '/account-two', content: 'private invalid data'});
        const snapshot = await readCalendar(files, new AbortController().signal);
        expect(snapshot.events).toHaveLength(2); expect(snapshot.sources).toHaveLength(3);
        expect(snapshot.warnings).toEqual(['CALENDAR_EVENT_JSON_INVALID']);
        expect(snapshot.sources.some(source => source.name === 'Empty calendar')).toBe(true);
    } finally {await manager.dispose();}
});
it('filters sources independently, restores the date route and releases subscriptions', async () => {
    const {files, manager} = await fixture();
    const sidebar = document.createElement('aside'), editor = document.createElement('main');
    document.body.append(sidebar, editor);
    const selected = vi.fn(), scanners = vi.fn(async () => {});
    const workbench = new CalendarWorkbench({files, sidebar, editor, selected, scanners});
    try {
        await workbench.start(); await workbench.openResource('/2026-11-01');
        expect(editor.querySelectorAll('.calendar__event')).toHaveLength(2);
        const checkbox = sidebar.querySelector<HTMLInputElement>('[data-calendar-source]')!;
        checkbox.checked = false; checkbox.dispatchEvent(new Event('change', {bubbles: true}));
        expect(editor.querySelectorAll('.calendar__event')).toHaveLength(1);
        editor.querySelector<HTMLButtonElement>('.calendar__event')!.click();
        expect(editor.querySelector('.calendar__detail')).not.toBeNull();
        expect(workbench.getActiveResourceId()).toContain('account-two');
        const search = sidebar.querySelector<HTMLInputElement>('[data-calendar-search]')!;
        search.value = 'missing'; search.dispatchEvent(new Event('input', {bubbles: true}));
        expect(editor.querySelectorAll('.calendar__event')).toHaveLength(0);
        sidebar.querySelector<HTMLButtonElement>('[data-calendar-action=scanners]')!.click();
        expect(scanners).toHaveBeenCalledOnce();
    } finally {await workbench.destroy(); await manager.dispose(); sidebar.remove(); editor.remove();}
});
