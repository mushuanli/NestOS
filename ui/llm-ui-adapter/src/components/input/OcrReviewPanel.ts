import {OcrReviewPanel as ReviewPanel} from '@itookit/llm-ui';
import {getLocale} from '@itookit/common';
export type {OcrReviewCallbacks} from '@itookit/llm-ui';

export class OcrReviewPanel extends ReviewPanel {
    constructor(container: HTMLElement) {super(container, {locale: getLocale()});}
}
