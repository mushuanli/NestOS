import {expect, it} from 'vitest';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import {canConsumeContextDraft, contextDraftMatchesRequest, prepareInputContextDraft, readInputContextDraft,
    sameInputContextDraft} from './context-draft';

const target = {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'};
const draft = () => ({revision: 1, sessionId: 'session', branchId: 'main', target: {...target},
    selection: {mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1, checkpointRef: 'checkpoint-A'}});
const request = (): SubmissionRequest => ({target, expectedTarget: target, expectedSessionId: 'session', expectedBranch: 'main',
    source: {kind: 'composer', text: 'Input', attachments: [], values: {}}, overrides: {harnessConversation: draft().selection}});

it('validates and clones a precise checkpoint draft without refreshing any references', () => {
    const original = draft(), saved = readInputContextDraft(original)!;
    original.selection.checkpointRef = 'checkpoint-B'; original.target.version = '2';
    expect(saved).toMatchObject({target, selection: {checkpointRef: 'checkpoint-A', expectedBindingRevision: 2}});
    expect(readInputContextDraft(undefined)).toBeUndefined();
});

it.each([null, [], {}, {...draft(), revision: -1}, {...draft(), revision: 0.5}, {...draft(), sessionId: ''},
    {...draft(), target: {kind: 'agent', id: 'worker'}}, {...draft(), basis: 'ephemeral'},
    {...draft(), selection: {mode: 'continue', bindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1}},
    {...draft(), selection: {...draft().selection, expectedBindingRevision: 0}}, {...draft(), selection: {...draft().selection, checkpointRef: ''}}])
('rejects an invalid context draft without coercing it to a new conversation: %j', value => {
    expect(() => readInputContextDraft(value)).toThrowError(expect.objectContaining({code: 'CONTEXT_DRAFT_INVALID'}));
});

it.each(['sessionId', 'branchId', 'target'])('preserves a changed %s scope and requires explicit revalidation', field => {
    const selected = draft(), scope = {sessionId: 'session', branchId: 'main', target};
    const changed = {...scope, [field]: field === 'target' ? {...target, version: '2'} : 'other'};
    expect(() => prepareInputContextDraft(selected, changed)).toThrowError(expect.objectContaining({code: 'CONTEXT_DRAFT_SCOPE_CHANGED'}));
    expect(selected.selection.checkpointRef).toBe('checkpoint-A');
});

it('does not equate another checkpoint or a changed UI revision with the submitted context', () => {
    const selected = draft(); expect(contextDraftMatchesRequest(selected, request())).toBe(true);
    expect(sameInputContextDraft(selected, {...selected, revision: 2})).toBe(false);
    expect(canConsumeContextDraft(selected, selected, {...selected, selection: {...selected.selection, checkpointRef: 'checkpoint-B'}}, request())).toBe(false);
    expect(canConsumeContextDraft(selected, selected, {...selected, revision: 2}, request())).toBe(false);
    expect(canConsumeContextDraft(selected, selected, selected, request())).toBe(true);
});

it('preserves a newer selection when an old ledger has no context evidence', () => {
    const selected = draft(), legacy = {...request(), overrides: undefined};
    expect(canConsumeContextDraft(undefined, selected, selected, legacy)).toBe(false);
    expect(canConsumeContextDraft(undefined, undefined, undefined, legacy)).toBe(true);
    expect(canConsumeContextDraft(undefined, undefined, undefined, request())).toBe(false);
});

it('distinguishes an explicit new selection from a legacy absent override', () => {
    const selected = {...draft(), selection: {mode: 'new' as const}}, call = {...request(), overrides: {harnessConversation: {mode: 'new' as const}}};
    expect(contextDraftMatchesRequest(selected, call)).toBe(true);
    expect(contextDraftMatchesRequest(selected, {...call, overrides: undefined})).toBe(false);
    expect(() => prepareInputContextDraft(selected, selected, draft().selection)).toThrowError(expect.objectContaining({code: 'CONTEXT_DRAFT_SELECTION_CHANGED'}));
});
