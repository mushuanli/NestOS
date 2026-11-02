import {getLocale} from '@itookit/common';

/** Keep visible dates and machine-readable timestamps consistent across views. */
export function setTimePresentation(element: HTMLTimeElement, value: number | null | undefined, fallback: string): void {
    const date = typeof value === 'number' && value > 0 ? new Date(value) : undefined;
    if (!date || !Number.isFinite(date.getTime())) {
        element.textContent = fallback;
        element.removeAttribute('datetime'); element.removeAttribute('title');
        return;
    }
    element.textContent = new Intl.DateTimeFormat(getLocale(), {dateStyle: 'medium', timeStyle: 'medium'}).format(date);
    element.dateTime = date.toISOString(); element.title = date.toLocaleString(getLocale());
}
