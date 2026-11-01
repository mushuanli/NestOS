export interface CalendarSource {id: string; name: string; account?: string; archivedAt?: number}
export interface CalendarEvent {
    key: string; id: string; sourceId: string; sourceName: string; title: string;
    start: string; end: string; allDay: boolean; location: string; description: string; timeZone: string;
}
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Archive paths scope identities to an account/calendar, including legacy source strings. */
export function parseCalendarEvent(content: string, path: string): CalendarEvent | undefined {
    const data = object(JSON.parse(content));
    if (!text(data.id)) throw new Error('CALENDAR_EVENT_ID_REQUIRED');
    if (data.status === 'cancelled') return;
    const begin = object(data.start), finish = object(data.end), allDay = !!text(begin.date);
    const start = text(allDay ? begin.date : begin.dateTime ?? data.start);
    const end = text(allDay ? finish.date : finish.dateTime ?? data.end);
    if (!validDate(start, allDay) || !validDate(end, allDay) || endValue(end, allDay) <= endValue(start, allDay))
        throw new Error('CALENDAR_EVENT_DATES_INVALID');
    const sourceId = path.slice(0, path.lastIndexOf('/')) || '/', source = object(data.source), calendar = object(data.calendar);
    const sourceName = [text(source.name) || text(calendar.account), text(calendar.name) || text(calendar.id)].filter(Boolean).join(' · ')
        || sourceId.split('/').filter(Boolean).slice(-3).join(' / ') || text(data.source);
    return {key: path, id: text(data.id), sourceId, sourceName, title: text(data.summary) || text(data.title),
        start, end, allDay, location: text(data.location), description: text(data.description), timeZone: text(begin.timeZone)};
}
function validDate(value: string, allDay: boolean): boolean {
    if (allDay) return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
    return /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
const endValue = (value: string, allDay: boolean) => Date.parse(value + (allDay ? 'T00:00:00Z' : ''));
export function dateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function onDay(event: CalendarEvent, date: string): boolean {
    if (event.allDay) return event.start <= date && event.end > date;
    const start = new Date(date + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate() + 1);
    return Date.parse(event.start) < end.getTime() && Date.parse(event.end) > start.getTime();
}
export function monthDays(month: Date): string[] {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    return Array.from({length: 42}, (_, index) => {const day = new Date(start); day.setDate(day.getDate() + index); return dateKey(day);});
}
