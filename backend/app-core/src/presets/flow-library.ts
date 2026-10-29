import essayReview from './essay-review.json';
import gmailCollect from './google-gmail-collect.json';
import calendarCollect from './google-calendar-collect.json';
import ankiGenerate from './anki-generate.json';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { Drawer } from '@itookit/app-contracts';

/** Host templates are copied so consumers cannot mutate the shared product catalog. */
export function createNestosFlowLibrary(): FlowDraft[] {
    return [essayReview, ankiGenerate, gmailCollect, calendarCollect].map(template => structuredClone(template) as unknown as FlowDraft);
}

/** Default organization is product data; user assignments remain authoritative. */
export function createNestosFlowDrawers(): Drawer[] {
    return [];
}
