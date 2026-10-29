import {describe, expect, it, vi} from 'vitest';
import type {CallTargetCatalog, ChatView, ComposerDraft} from '@itookit/llm-ui';
import {refreshDraftTarget, restoreDraftTarget} from './restore-draft-target';

const old = {kind: 'agent', id: 'assistant', version: 'old', digest: 'old'};
const current = {...old, version: 'new', digest: 'new'};
const draft: ComposerDraft = {scopeId: 'stable', revision: 4, textRevision: 2, text: 'Keep this input', attachments: [], target: old};
const catalog: CallTargetCatalog = {entries: [{id: 'current', label: 'Assistant', target: current}], loading: false};
describe('next input target restoration', () => {
    it('resolves a plain Agent preference to the current version without changing draft identity', () => {
        expect(restoreDraftTarget(draft, catalog)).toEqual({...draft, target: current});
        expect(draft.target).toBe(old);
        expect(restoreDraftTarget({...draft, target: undefined}, catalog, old).target).toEqual(current);
    });
    it('keeps structured parameters bound to their original version for explicit confirmation', () => {
        const structured = {...draft, input: {revision: 1, targetId: 'old', signature: {id: 'flow', revision: 1, digest: 'one'}, json: '{invalid'}};
        expect(restoreDraftTarget(structured, catalog)).toBe(structured);
        const flow = {...structured, target: {...old, kind: 'flow'}};
        expect(restoreDraftTarget(flow, {...catalog, entries: [{id: 'flow', label: 'Flow', target: {...current, kind: 'flow'}}]})).toBe(flow);
    });
    it('does not silently replace removed targets', () => {
        expect(restoreDraftTarget(draft, {...catalog, entries: []})).toBe(draft);
        expect(restoreDraftTarget({...draft, target: undefined}, {...catalog, entries: []}, old).target).toEqual(old);
    });
    it('resolves Flow and parameterized Agent preferences when no parameters were confirmed', () => {
        for (const kind of ['agent', 'flow']) {
            const preference = {...draft, target: {...old, kind}};
            const published = {...current, kind};
            const entries = [{id: 'current', label: 'Parameterized target', target: published,
                inputContract: {targetId: 'current', signature: {id: 'flow', revision: 2, digest: 'two'}, label: 'Arguments'}}];
            expect(restoreDraftTarget(preference, {...catalog, entries})).toEqual({...preference, target: published});
            expect(restoreDraftTarget({...preference, target: undefined}, {...catalog, entries}, preference.target).target).toEqual(published);
        }
    });
    it('keeps confirmed context bound to its original target version', () => {
        const contextual = {...draft, context: {revision: 1, value: {selection: {mode: 'fork'}}}};
        expect(restoreDraftTarget(contextual, catalog)).toBe(contextual);
    });
    it('refreshes only existing unconfirmed preferences with the displayed draft revision', () => {
        const configureInput = vi.fn(), view = {inputBusy: false, getDraft: () => draft, configureInput} as unknown as ChatView;
        expect(refreshDraftTarget(view, catalog)).toBe(true);
        expect(configureInput).toHaveBeenCalledWith({target: current}, draft.revision);
        expect(draft).toMatchObject({target: old, text: 'Keep this input', scopeId: 'stable', textRevision: 2});
        configureInput.mockClear();
        expect(refreshDraftTarget({...view, inputBusy: true}, catalog)).toBe(false);
        expect(refreshDraftTarget({...view, getDraft: () => ({...draft, target: undefined})}, catalog)).toBe(false);
        expect(configureInput).not.toHaveBeenCalled();
    });
    it('does not select a Flow or parameterized Agent just because it is listed first', () => {
        const fresh = {...draft, target: undefined};
        const flow = {id: 'flow', label: 'Flow', target: {...current, kind: 'flow'}};
        const parameterized = {id: 'anki', label: 'Anki', target: {...current, id: 'anki'}, inputContract: {targetId: 'anki', label: 'Input', signature: {id: 'flow', revision: 1, digest: 'one'}}};
        expect(restoreDraftTarget(fresh, {...catalog, entries: [flow, parameterized]}).target).toBeUndefined();
        expect(restoreDraftTarget(fresh, {...catalog, entries: [flow, parameterized, catalog.entries[0]]}).target).toEqual(current);
        expect(restoreDraftTarget(fresh, {...catalog, entries: [flow, parameterized]}, undefined, 'default').target).toBeUndefined();
    });
    it('preserves the draft while the catalog is loading or failed', () => {
        expect(restoreDraftTarget(draft, {...catalog, loading: true})).toBe(draft);
        expect(restoreDraftTarget(draft, {...catalog, error: 'CATALOG_READ_FAILED'})).toBe(draft);
    });
});
