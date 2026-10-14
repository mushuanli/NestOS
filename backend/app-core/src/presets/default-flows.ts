import preset from './essay-review.json';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { FlowDefinitionStore } from '@itookit/llm-flow';

export const ESSAY_REVIEW_FLOW_ID = preset.id;

/** Product presets stay at the application composition boundary. */
export function essayReviewDraft(): FlowDraft {
    return { ...structuredClone(preset), updatedAt: Date.now() } as unknown as FlowDraft;
}

export async function seedDefaultFlows(store: FlowDefinitionStore): Promise<void> {
    const draft = await store.installBuiltinDraft(essayReviewDraft());
    if (draft) await store.createRevision(draft);
}
