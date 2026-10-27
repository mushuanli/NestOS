import preset from './essay-review.json';
import { createNestosFlowLibrary } from './flow-library';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { FlowDefinitionStore } from '@itookit/llm-flow';

export const ESSAY_REVIEW_FLOW_ID = preset.id;

/** Product presets stay at the application composition boundary. */
export function essayReviewDraft(): FlowDraft {
    return { ...structuredClone(preset), updatedAt: Date.now() } as unknown as FlowDraft;
}

export async function seedDefaultFlows(store: FlowDefinitionStore, ensure?: (id: string) => Promise<unknown>): Promise<void> {
    for (const template of createNestosFlowLibrary()) {
        const draft = await store.installBuiltinDraft(template);
        if (draft) await store.createRevision(draft);
        await ensure?.(template.id);
    }
}
