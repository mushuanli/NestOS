import {sameTargetRef} from '@itookit/llm-flow/contracts';
import type {ContextOptionsPage, ContextOptionsQuery, ContextSourceOption, ContextCheckpointOption} from '@itookit/llm-session/contracts';
import type {InputContextDraft} from './context-draft';

export function assertContextOptionsPage(page: ContextOptionsPage, query: ContextOptionsQuery): void {
    if (!validPageScope(page, query) || !validPageShape(page)) throw failure('CONTEXT_OPTIONS_RESPONSE_INVALID');
    if (page.dynamicPolicy !== 'dispatch-validation-required' || !['new', 'fork', 'continue'].every(mode => validMode(page.modes[mode as keyof typeof page.modes]))) throw failure('CONTEXT_OPTIONS_RESPONSE_INVALID');
    for (const source of page.sources) assertSource(source);
    for (const checkpoint of page.checkpoints ?? []) assertCheckpoint(checkpoint);
}
function validPageScope(page: ContextOptionsPage, query: ContextOptionsQuery): boolean {
    return !!page && page.sessionId === query.sessionId && page.branchId === query.branchId && sameTargetRef(page.target, query.target);
}
function validPageShape(page: ContextOptionsPage): boolean {
    return ['direct-harness', 'other'].includes(page.kind) && Array.isArray(page.sources) && !!page.modes && typeof page.basis === 'string';
}
function assertSource(source: ContextSourceOption): void {
    if (!source || !source.ref || typeof source.ref.bindingId !== 'string' || typeof source.branchId !== 'string'
        || !Number.isSafeInteger(source.ref.revision) || !Number.isSafeInteger(source.ref.generation) || !validQualification(source.fork)) throw failure('CONTEXT_OPTIONS_RESPONSE_INVALID');
}
function assertCheckpoint(checkpoint: ContextCheckpointOption): void {
    if (!checkpoint || typeof checkpoint.ref !== 'string' || !validQualification(checkpoint.fork)) throw failure('CONTEXT_OPTIONS_RESPONSE_INVALID');
}
function validMode(mode: ContextOptionsPage['modes']['new']): boolean {
    return !!mode && typeof mode.supported === 'boolean' && (mode.code === undefined || /^[A-Z][A-Z0-9_]{0,79}$/.test(mode.code));
}
function validQualification(value: ContextSourceOption['fork']): boolean {
    return !!value && ['static-compatible', 'unavailable'].includes(value.status) && Array.isArray(value.codes)
        && value.codes.every(code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code));
}
export function assertContextOptionSelection(page: ContextOptionsPage, draft: InputContextDraft): void {
    if (page.kind !== 'direct-harness') throw failure('CONTEXT_TARGET_UNSUPPORTED');
    if (draft.selection.mode === 'new') {if (!page.modes.new.supported) throw failure(page.modes.new.code ?? 'CONTEXT_NEW_UNSUPPORTED'); return;}
    assertForkSelection(page, draft.selection);
}
function assertForkSelection(page: ContextOptionsPage, selected: Extract<InputContextDraft['selection'], {mode: 'fork'}>): void {
    const source = page.sources.find(row => row.ref.bindingId === selected.sourceBindingId);
    if (!source || source.ref.revision !== selected.expectedBindingRevision || source.ref.generation !== selected.expectedGeneration) throw failure('CONTEXT_BINDING_CHANGED');
    const checkpoint = page.checkpoints?.find(row => row.ref === selected.checkpointRef);
    if (!page.modes.fork.supported || source.fork.status !== 'static-compatible' || checkpoint?.fork.status !== 'static-compatible') throw failure(checkpoint?.fork.codes[0] ?? source.fork.codes[0] ?? 'CONTEXT_FORK_UNAVAILABLE');
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
