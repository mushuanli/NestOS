import {escapeAttr, escapeHTML, getLocale, t} from '@itookit/common';
import {dateKey, monthDays, onDay, type CalendarEvent, type CalendarSource} from './model';
const esc = escapeHTML;
export const label = (key: string) => t(`calendar.${key}` as Parameters<typeof t>[0]);
export const button = (action: string, title: string) => `<button type="button" data-calendar-action="${action}">${esc(label(title))}</button>`;
const hue = (index: number) => `hsl(${index * 137.5 % 360} 60% 42%)`;
const color = (event: CalendarEvent, sources: CalendarSource[]) => hue(sources.findIndex(source => source.id === event.sourceId));

export function calendarSidebar(sources: CalendarSource[], disabled: Set<string>, showTitle = true): string {
    return `${showTitle ? `<h2>${esc(label('title'))}</h2>` : ''}<p>${esc(label('sourcesHelp'))}</p>
        <label>${esc(label('search'))}<input type="search" data-calendar-search></label>
        <fieldset><legend>${esc(label('sources'))}</legend>${sources.map((source, index) => `<label class="calendar__source"><input type="checkbox" data-calendar-source="${escapeAttr(source.id)}"${disabled.has(source.id) ? '' : ' checked'}><span class="calendar__source-color" style="background:${hue(index)}"></span><span>${esc(source.name)}${source.archivedAt ? `<small>${esc(label('archivedAt'))}: ${esc(new Date(source.archivedAt).toLocaleString(getLocale()))}</small>` : ''}</span></label>`).join('') || `<p>${esc(label('noSources'))}</p>`}</fieldset>
        <button type="button" data-calendar-action="scanners">${esc(label('manageSources'))}</button>
        <p class="calendar__help">${esc(label('readOnly'))}</p>`;
}
export function calendarMain(month: Date, selected: string, events: CalendarEvent[], sources: CalendarSource[], detail?: CalendarEvent): string {
    const heading = month.toLocaleDateString(getLocale(), {year: 'numeric', month: 'long'});
    const localeDay = new Date(2024, 0, 1);
    const weekdays = Array.from({length: 7}, (_, i) => {const day = new Date(localeDay); day.setDate(day.getDate() + i); return day.toLocaleDateString(getLocale(), {weekday: 'short'});});
    return `<header class="calendar__toolbar"><h2>${esc(heading)}</h2><div>${button('previous', 'previous')}${button('today', 'today')}${button('next', 'next')}${button('refresh', 'refresh')}</div></header>
        <p class="calendar__help">${esc(label('timezone'))}: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>
        <div class="calendar__grid" aria-label="${esc(heading)}">${weekdays.map(day => `<div class="calendar__weekday">${esc(day)}</div>`).join('')}
        ${monthDays(month).map(day => dayCell(day, selected, month, events, sources)).join('')}</div>
        <section class="calendar__agenda"><h3>${esc(new Date(selected + 'T12:00:00').toLocaleDateString(getLocale(), {dateStyle: 'full'}))}</h3>
        ${events.filter(event => onDay(event, selected)).sort((a, b) => a.start.localeCompare(b.start)).map(event => eventRow(event, sources)).join('') || `<p>${esc(label('noEvents'))}</p>`}</section>
        ${detail ? eventDetail(detail) : ''}`;
}
function dayCell(day: string, selected: string, month: Date, events: CalendarEvent[], sources: CalendarSource[]): string {
    const matches = events.filter(event => onDay(event, day));
    return `<div class="calendar__day" data-outside="${day.slice(0, 7) !== dateKey(month).slice(0, 7)}" data-selected="${day === selected}">
        <button type="button" class="calendar__date" data-calendar-day="${day}" aria-pressed="${day === selected}" aria-label="${day}"${day === dateKey(new Date()) ? ' aria-current="date"' : ''}>${Number(day.slice(-2))}</button>
        ${matches.slice(0, 3).map(event => `<button type="button" class="calendar__chip" style="--calendar-event-color:${color(event, sources)}" data-calendar-event="${escapeAttr(event.key)}">${esc(event.title || label('untitled'))}</button>`).join('')}
        ${matches.length > 3 ? `<button type="button" data-calendar-day="${day}">+${matches.length - 3}</button>` : ''}</div>`;
}
function eventRow(event: CalendarEvent, sources: CalendarSource[]): string {
    return `<button type="button" class="calendar__event" data-calendar-event="${escapeAttr(event.key)}" style="--calendar-event-color:${color(event, sources)}">
        <span>${esc(timeLabel(event))}</span><strong>${esc(event.title || label('untitled'))}</strong><small>${esc(event.sourceName)}</small></button>`;
}
function timeLabel(event: CalendarEvent): string {
    if (event.allDay) return label('allDay');
    return new Date(event.start).toLocaleTimeString(getLocale(), {hour: '2-digit', minute: '2-digit'}) + ' – '
        + new Date(event.end).toLocaleTimeString(getLocale(), {hour: '2-digit', minute: '2-digit'});
}
function eventDetail(event: CalendarEvent): string {
    const period = event.allDay ? `${event.start} → ${event.end} (${label('exclusiveEnd')})`
        : `${new Date(event.start).toLocaleString(getLocale())} → ${new Date(event.end).toLocaleString(getLocale())}`;
    return `<section class="calendar__detail" aria-label="${esc(label('details'))}"><header><h3>${esc(event.title || label('untitled'))}</h3>${button('close', 'close')}</header>
        <dl><dt>${esc(label('source'))}</dt><dd>${esc(event.sourceName)}</dd><dt>${esc(label('time'))}</dt><dd>${esc(period)}</dd>
        ${event.timeZone ? `<dt>${esc(label('originalTimezone'))}</dt><dd>${esc(event.timeZone)}</dd>` : ''}
        ${event.location ? `<dt>${esc(label('location'))}</dt><dd>${esc(event.location)}</dd>` : ''}</dl>
        <p class="calendar__description">${esc(event.description)}</p></section>`;
}
