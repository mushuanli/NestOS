import {expect, it, vi} from 'vitest';
import {DiagnosticJournal} from '../src/diagnostics/journal';

it('paginates filtered diagnostic groups with bounded offsets and exact group totals', async () => {
    const journal = new DiagnosticJournal();
    const debug = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        for (let index = 0; index < 45; index++) journal.record({module: 'application', operation: 'test', stage: 'query',
            result: 'failure', level: index % 2 ? 'error' : 'warn', code: 'EVENT_' + index, projectId: index < 25 ? 'a' : 'b'});
        const first = await journal.query({projectId: 'a', limit: 20});
        const last = await journal.query({projectId: 'a', limit: 20, offset: 20});
        expect(first).toMatchObject({matchingGroups: 25, retained: 45, offset: 0, limit: 20, truncated: true});
        expect(first.events).toHaveLength(20); expect(last.events).toHaveLength(5);
        expect(last).toMatchObject({matchingGroups: 25, offset: 20, truncated: false});
        expect(new Set([...first.events, ...last.events].map(event => event.id)).size).toBe(25);
        expect(first.events[0].code).toBe('EVENT_24'); expect(last.events.at(-1)?.code).toBe('EVENT_0');
        expect(await journal.query({projectId: 'a', offset: 999, limit: 20})).toMatchObject({offset: 20, events: last.events});
        expect(await journal.query({projectId: 'a', offset: -10, limit: 20})).toMatchObject({offset: 0, events: first.events});
        const filtered = await journal.query({projectId: 'a', level: 'error', search: 'EVENT_1', limit: 20});
        expect(filtered.matchingGroups).toBe(6); expect(filtered.events.every(event => event.level === 'error')).toBe(true);
        expect(await journal.query({search: 'absent', offset: 40, limit: 20})).toMatchObject({events: [], offset: 0, matchingGroups: 0});
    } finally {debug.mockRestore(); await journal.dispose();}
});
