import {isTargetRef, type TargetRef} from '@itookit/llm-flow/contracts';
import {sha256HexSync} from '@itookit/llm-context/digest';
import {assertContextBindingQuery, type ContextBindingCursor, type ContextBindingSummary, type ContextCheckpointSummary} from './context-bindings';

/** Destination identity is explicit; source bindings may belong to another branch of this Session. */
export interface ContextOptionsQuery {
    sessionId: string;
    branchId: string;
    target: TargetRef;
    overrides?: {executionMode?: 'chat' | 'agent'; systemPromptAppend?: string};
    bindingId?: string;
    checkpointRef?: string;
    cursor?: ContextOptionsCursor;
    limit?: number;
}
export interface ContextOptionsCursor {basis: string; catalog: ContextBindingCursor}
export interface ContextModeSupport {supported: boolean; code?: string}
export interface ContextSourceQualification {status: 'static-compatible' | 'unavailable'; codes: string[]}
export interface ContextSourceOption extends ContextBindingSummary {fork: ContextSourceQualification}
export type ContextCheckpointOption = ContextCheckpointSummary & {fork: ContextSourceQualification};
export interface ContextOptionsPage {
    kind: 'direct-harness' | 'other';
    target: TargetRef;
    sessionId: string;
    branchId: string;
    /** Observation consistency only; never a grant or a complete policy-compatibility proof. */
    basis: string;
    revision: number | null;
    dynamicPolicy: 'dispatch-validation-required';
    modes: {new: ContextModeSupport; fork: ContextModeSupport; continue: ContextModeSupport};
    sources: ContextSourceOption[];
    checkpoints?: ContextCheckpointOption[];
    nextCursor?: ContextOptionsCursor;
}
export type ContextOptionsReader = (query: ContextOptionsQuery) => Promise<ContextOptionsPage>;

export function assertContextOptionsQuery(query: ContextOptionsQuery): void {
    assertOptionsShape(query);
    if (query.checkpointRef !== undefined && (!query.bindingId || !reference(query.checkpointRef) || query.cursor)) invalid();
    if (query.overrides !== undefined) assertOverrides(query.overrides);
    if (query.cursor !== undefined) assertOptionsCursor(query.cursor);
    assertContextBindingQuery({sessionId: query.sessionId, branchId: query.branchId, bindingId: query.bindingId,
        cursor: query.cursor?.catalog, limit: query.limit});
}

function assertOptionsShape(query: ContextOptionsQuery): void {
    if (!query || typeof query !== 'object' || Array.isArray(query)) invalid();
    if (Object.keys(query).some(key => !['sessionId', 'branchId', 'target', 'overrides', 'bindingId', 'checkpointRef', 'cursor', 'limit'].includes(key))) invalid();
    if (!isTargetRef(query.target) || typeof query.branchId !== 'string' || !query.branchId) invalid();
}

/** Shared with direct execution; the browser must not construct or parse these host identities. */
export function directHarnessContextIdentity(agent: {id: string; version: string}, project: unknown) {
    return {targetRef: `agent:${agent.id}@${agent.version}`, workspaceRef: sha256HexSync(JSON.stringify(project)),
        memoryPolicyRef: 'native-project-inherited' as const};
}

function assertOptionsCursor(cursor: ContextOptionsCursor): void {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !/^[a-f0-9]{64}$/.test(cursor.basis)
        || Object.keys(cursor).some(key => !['basis', 'catalog'].includes(key)) || !cursor.catalog) invalid();
}

function assertOverrides(overrides: NonNullable<ContextOptionsQuery['overrides']>): void {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.keys(overrides).some(key => !['executionMode', 'systemPromptAppend'].includes(key))) invalid();
    if (overrides.executionMode !== undefined && !['chat', 'agent'].includes(overrides.executionMode)) invalid();
    if (overrides.systemPromptAppend !== undefined && (typeof overrides.systemPromptAppend !== 'string'
        || overrides.systemPromptAppend.length > 65536)) invalid();
}
function reference(value: unknown): value is string {return typeof value === 'string' && !!value && value.length <= 4096;}
function invalid(): never {throw Object.assign(new Error('Invalid context options query'), {code: 'CONTEXT_OPTIONS_INVALID'});}
