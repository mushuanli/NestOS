import essayReview from './essay-review-isolated.json';
import type { FlowDraft } from '@itookit/llm-flow/contracts';

/** Host templates are copied so consumers cannot mutate the shared product catalog. */
export function createMindosFlowLibrary(): FlowDraft[] {
    return [structuredClone(essayReview) as unknown as FlowDraft];
}
