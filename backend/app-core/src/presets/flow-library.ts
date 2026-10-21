import essayReview from './essay-review-isolated.json';
import ankiGenerate from './anki-generate.json';
import ankiBuild from './anki-build.json';
import ankiFromImage from './anki-from-image.json';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { Drawer } from '@itookit/app-contracts';
import { t } from '@itookit/common';

/** Host templates are copied so consumers cannot mutate the shared product catalog. */
export function createMindosFlowLibrary(): FlowDraft[] {
    return [essayReview, ankiBuild, ankiGenerate, ankiFromImage].map(template => structuredClone(template) as unknown as FlowDraft);
}

/** Default organization is product data; user assignments remain authoritative. */
export function createMindosFlowDrawers(): Drawer[] {
    return [{ id: '/drawers/flows-subflows', kind: 'flows', name: t('toolbox.subflows'),
        paths: [`/flows/${ankiBuild.id}.flow`] }];
}
