import {getLocale} from '@itookit/common';
import {setTimePresentation as presentTime} from '@itookit/ui-common';

export function setTimePresentation(element: HTMLTimeElement, value: number | null | undefined, fallback: string): void {
    presentTime(element, value, fallback, getLocale());
}
