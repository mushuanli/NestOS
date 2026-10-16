import { readFile } from 'node:fs/promises';
import type { FlowDraft, FlowRevision } from '@itookit/llm-flow/contracts';
import { createFlowRevision, flowRevisionDigest } from '@itookit/llm-flow';

/** Load a `.flow` draft or revision and normalize it to an immutable FlowRevision. */
export async function loadFlowDefinition(file: string): Promise<FlowRevision> {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (typeof raw.draftVersion === 'number') {
        const draft = raw as unknown as FlowDraft;
        return createFlowRevision(draft, draft.draftVersion, draft.updatedAt ?? Date.now());
    }
    const revision = raw as unknown as FlowRevision;
    if (typeof revision.id !== 'string' || typeof revision.revision !== 'number' || !Array.isArray(revision.nodes) || !Array.isArray(revision.edges)) {
        throw new Error('Invalid .flow file: expected FlowDraft or FlowRevision JSON');
    }
    return {
        ...revision,
        digest: revision.digest || flowRevisionDigest(revision as Omit<FlowRevision, 'digest'>),
    };
}
