import type { FlowDraft, FlowRevision } from '../contracts';
import { assertInlineFunctionTree } from './inline-functions';

/** Drafts and revisions share one authored body; keep new fields through every projection. */
export function flowDefinitionBody(flow: FlowDraft | FlowRevision) {
    const { id, name, nodes, edges, parameters, inputGroups, toolDependencies, outputs, variables, connections, defaultConnection,
        systemPrompt, toolIds, defaults, runPolicy } = flow;
    return structuredClone({ id, name, nodes, edges, parameters: parameters ?? [], connections: connections ?? [],
        ...(toolDependencies ? {toolDependencies} : {}),
        ...(inputGroups ? {inputGroups} : {}),
        ...(defaultConnection !== undefined ? { defaultConnection } : {}),
        ...(outputs ? { outputs } : {}), ...(variables ? { variables } : {}),
        ...(systemPrompt ? { systemPrompt } : {}), ...(toolIds ? { toolIds } : {}),
        ...(defaults ? { defaults } : {}), ...(runPolicy ? { runPolicy } : {}) });
}

/** Imported published definitions become drafts while retaining their lexical declarations. */
export function flowRevisionToDraft(flow: FlowRevision): FlowDraft {
    assertInlineFunctionTree(flow);
    return revisionDraft(flow);
}

function revisionDraft(flow: FlowRevision): FlowDraft {
    return { ...flowDefinitionBody(flow), layout: {}, draftVersion: flow.revision, updatedAt: flow.createdAt,
        ...(flow.functions ? { functions: flow.functions.map(revisionDraft) } : {}) };
}
