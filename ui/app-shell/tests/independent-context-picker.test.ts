// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger, type ComposerDraft} from '@itookit/llm-ui';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createSessionChatBinding, createSessionChatView} from '../../llm-ui-adapter/src/independent/session';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren();});
const target = {kind: 'agent' as const, id: 'harness', version: '1', digest: 'published'};
async function fixture(initialDraft?: ComposerDraft) {
    let release!: () => void;
    const execute = vi.fn(async (name: string, args?: any): Promise<any> => {
        if (name === SessionCommand.InspectSubmissionReceipt) return {operationId: args.submission.id, status: 'accepted'};
        if (name === SessionCommand.ListTargets) return {entries: [{target, name: 'Harness'}], issues: []};
        if (name === SessionCommand.ContextOptions) return {...args, kind: 'direct-harness', basis: 'basis', revision: 1, dynamicPolicy: 'dispatch-validation-required',
            modes: {new: {supported: true}, fork: {supported: true}, continue: {supported: false}},
            sources: [{ref: {bindingId: 'binding', revision: 3, generation: 1}, branchId: 'source', fork: {status: 'static-compatible', codes: []}}],
            ...(args.bindingId ? {checkpoints: [{ref: 'point', fork: {status: 'static-compatible', codes: []}}]} : {})};
        if (name === SessionCommand.Submit) await new Promise<void>(resolve => {release = resolve;});
    });
    const binding = createSessionChatBinding({contextSelection: true, targetSelection: true, operations: createOperationLedger(), commands: {execute} as never,
        hasCommittedSubmission: async () => true, session: {id: 'parent', getSnapshot: () => ({view: {manifest: {currentBranch: 'main'}}}),
            getSessions: () => [], isGenerating: () => false, onEvent: () => () => {}} as never});
    cleanup.push(() => binding.dispose()); await binding.refreshTargets();
    const host = document.createElement('div'); document.body.append(host);
    const saves: ComposerDraft[] = [];
    const view = await createSessionChatView(host, binding, {initialDraft, saveDraft: async draft => {saves.push(structuredClone(draft));}});
    cleanup.push(() => view.destroy());
    return {view, host, execute, saves, release: () => release()};
}
const click = (host: HTMLElement, action: string) => host.querySelector<HTMLButtonElement>(`[data-context-action="${action}"]`)!.click();
async function choose(host: HTMLElement) {
    click(host, 'open'); await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[data-context-binding="0"]')?.disabled).toBe(false));
    host.querySelector<HTMLButtonElement>('[data-context-binding="0"]')!.click();
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[data-context-checkpoint="0"]')?.disabled).toBe(false));
    host.querySelector<HTMLButtonElement>('[data-context-checkpoint="0"]')!.click(); click(host, 'confirm');
}
it('selects a checkpoint through the shared picker and freezes it while the next selection remains editable', async () => {
    const f = await fixture(); await choose(f.host); f.view.setText('Task'); await f.view.flushDraft();
    expect(f.saves.at(-1)?.context?.value).toMatchObject({selection: {mode: 'fork', checkpointRef: 'point'}});
    const sending = f.view.submit(); await vi.waitFor(() => expect(f.execute.mock.calls.some(([name]) => name === SessionCommand.Submit)).toBe(true));
    click(f.host, 'clear'); await choose(f.host);
    const next = structuredClone(f.view.getDraft().context); f.release(); await sending;
    expect(f.view.getDraft().context).toEqual(next);
    expect(f.execute.mock.calls.find(([name]) => name === SessionCommand.Submit)?.[1]).toMatchObject({overrides: {harnessConversation: {checkpointRef: 'point'}}});
});
it('restores saved selection without losing text and isolates hidden picker actions', async () => {
    const f = await fixture(); await choose(f.host); f.view.setText('Preserved'); await f.view.flushDraft();
    const restored = await fixture(structuredClone(f.view.getDraft()));
    expect(restored.view.getDraft().context).toEqual(f.view.getDraft().context); expect(restored.view.getDraft().text).toBe('Preserved');
    restored.view.setActive(false); expect(restored.host.querySelector<HTMLElement>('.workspace-context')!.hidden).toBe(true);
    const before = structuredClone(restored.view.getDraft().context); click(restored.host, 'clear');
    expect(restored.view.getDraft().context).toEqual(before);
    restored.view.setActive(true); expect(restored.host.querySelector<HTMLElement>('.workspace-context')!.hidden).toBe(false);
});
