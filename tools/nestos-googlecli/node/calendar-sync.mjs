import {fail} from './client.mjs';
import {eventMaterial, archived} from './materials.mjs';
import {pageState, nextPage} from './sync-batch.mjs';

export function calendarSync(client, args, context, directory) {
    const base = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(args.calendarId) + '/events', range = calendarRange(args);
    return {
        async start() {return {mode: 'full', range, rangeEnd: range.max, pending: [], processed: 0, pageSize: Math.min(100, args.maxItems)};},
        page: state => calendarPage(client, base, state),
        advance(state) {
            if (nextPage(state)) return false;
            if (state.mode !== 'expand') state.syncToken = state.nextSyncToken;
            delete state.nextSyncToken;
            if (state.mode === 'delta' && range.max > state.rangeEnd) {
                state.mode = 'expand'; state.range = {min: state.rangeEnd, max: range.max}; return false;
            }
            state.rangeEnd = state.range.max; state.mode = 'delta'; return true;
        },
        read: entry => calendarEntry(client, base, context, directory, entry, range, args),
        expired: (error, state) => state.mode === 'delta' && error.code === 'GOOGLE_CALENDAR_LIST_HTTP_410' || !!state.pageToken && error.code === 'GOOGLE_CALENDAR_LIST_HTTP_400',
    };
}
async function calendarPage(client, base, state) {
    const url = new URL(base);
    url.search = new URLSearchParams({singleEvents: 'true', showDeleted: 'true', maxResults: String(state.pageSize),
        ...(state.mode === 'delta' ? {syncToken: state.syncToken} : {timeMin: state.range.min, timeMax: state.range.max}),
        ...(state.pageToken ? {pageToken: state.pageToken} : {})});
    const result = await client(url, 'CALENDAR_LIST');
    if (result.items !== undefined && !Array.isArray(result.items)) throw fail('GOOGLE_CALENDAR_INVALID_RESPONSE');
    pageState(state, result, (result.items ?? []).map(item => ({id: item?.id, removed: item?.status === 'cancelled'})));
    if (!result.nextPageToken && !result.nextSyncToken) throw fail('GOOGLE_CALENDAR_INVALID_RESPONSE');
}
async function calendarEntry(client, base, context, directory, entry, range, args) {
    if (entry.removed) return await archived(context.vfs, directory, entry.id) ? eventMaterial({id: entry.id, status: 'cancelled'}, args) : null;
    let event;
    try {event = await client(base + '/' + encodeURIComponent(entry.id), 'CALENDAR_READ');}
    catch (error) {if (error.code === 'GOOGLE_CALENDAR_READ_NOT_FOUND') return null; throw error;}
    if (!await archived(context.vfs, directory, entry.id) && !inRange(event, range)) return null;
    return eventMaterial(event, args);
}
function calendarRange(args) {
    const now = Date.now(), from = new Date(args.timeMin ?? now - (args.pastDays ?? 7) * 86400000), to = new Date(args.timeMax ?? now + (args.futureDays ?? 30) * 86400000);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +from >= +to || +to - +from > 366 * 86400000) throw fail('GOOGLE_CALENDAR_RANGE_INVALID');
    return {min: from.toISOString(), max: to.toISOString()};
}
function inRange(event, range) {
    const start = event.start?.dateTime ?? event.start?.date, end = event.end?.dateTime ?? event.end?.date;
    return event.status === 'cancelled' || start && end && Date.parse(end) > Date.parse(range.min) && Date.parse(start) < Date.parse(range.max);
}
