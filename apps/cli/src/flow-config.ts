import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FlowDraft, FlowRevision } from '@itookit/llm-flow/contracts';
import { createFlowRevision, flowRevisionDigest, checkFlowSyntax } from '@itookit/llm-flow';

/** Load a `.flow` draft or revision and normalize it to an immutable FlowRevision. */
export async function loadFlowDefinition(file: string): Promise<FlowRevision> {
    const source = await readFile(file, 'utf8');
    const checked = checkFlowSyntax(source);
    if (!checked.valid) throw new Error(checked.diagnostics.map(issue => `${issue.path ?? issue.nodeId ?? '$'}: ${issue.message}`).join('\n'));
    const raw = JSON.parse(source) as Record<string, unknown>;
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

/** Resolve explicit sibling definitions; the compiled Run snapshot freezes dependencies. */
export function siblingFlowResolver(file: string): (id: string, revision?: number) => Promise<FlowRevision | null> {
    const directory = path.dirname(path.resolve(file));
    return async (id, revision) => {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid sibling Flow id: ${id}`);
        let flow: FlowRevision;
        try { flow = await loadFlowDefinition(path.join(directory, `${id}.flow`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        if (flow.id !== id || revision !== undefined && flow.revision !== revision) throw new Error(`Sibling Flow identity or revision mismatch: ${id}`);
        return flow;
    };
}
