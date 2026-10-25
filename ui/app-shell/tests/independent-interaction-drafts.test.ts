// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallView} from '@itookit/llm-session/contracts';
import {IndependentCallPanel} from '../../llm-ui-adapter/src/components/IndependentCallPanel';
import {InteractionDraftPersistence} from '../../llm-ui-adapter/src/services/InteractionDraftPersistence';
let panel: IndependentCallPanel | undefined;
afterEach(() => {panel?.destroy(); document.body.replaceChildren();});
function fixture() {
    let revision = 0, uiState: any = {}, branch = 'main';
    const repository = {getManifest: async () => structuredClone({revision, uiState}), compareAndSetUIState: vi.fn(async (_id: string, expected: number, patch: any) => {
        if (expected !== revision) throw Object.assign(new Error('Conflict'), {code: 'SESSION_UI_STATE_CONFLICT'});
        uiState = {...uiState, ...structuredClone(patch)}; revision++;
    })};
    const view = {input: {title: 'Work', request: {expectedSessionId: 'parent', expectedBranch: 'main', source: {kind: 'arguments', value: {}}, submission: {id: 'call', source: {kind: 'conversation', ownerId: 'parent', id: 'call'}}}}, createdAt: 1, head: null, status: 'running',
        receipt: {operationId: 'call', callerSessionId: 'parent', status: 'accepted', executionSessionId: 'child', execution: {taskId: 'root', role: 'primary'}},
        controlCapabilities: {cancel: true, respond: true}, interactions: {total: 1, items: [{taskId: 'worker', interactionId: 'ask', kind: 'input', prompt: 'Question', requestedAt: 1}]}} as IndependentCallView;
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === IndependentCallCommand.List) return [view];
        if (name === IndependentCallCommand.Interaction) return {...args, interaction: {id: 'ask', kind: 'input', prompt: 'Question', requestedAt: 1, status: 'pending'}};
        if (name === IndependentCallCommand.Respond) return {...args, receipt: {requestId: args.requestId, taskId: 'worker', interactionId: 'ask', resolvedAt: 2}};
        throw new Error(name);
    });
    const open = async () => {
        panel?.destroy(); document.body.replaceChildren();
        panel = new IndependentCallPanel({execute} as never, 'parent', document.body, {branch: () => branch, operations: createOperationLedger(), interactionDrafts: new InteractionDraftPersistence(repository as never)});
        await panel.refresh(); document.querySelector<HTMLButtonElement>('[data-call-answer-action]')!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-call-answer] textarea')).not.toBeNull());
        return document.querySelector<HTMLTextAreaElement>('[data-call-answer] textarea')!;
    };
    return {repository, execute, open, state: () => uiState, branch: (id: string) => {branch = id; view.input.request.expectedBranch = id;}};
}
it('restores unfinished JSON and format after reopening, isolates branches, and clears only after answer admission', async () => {
    const f = fixture(), input = await f.open(); input.value = '{unfinished'; input.dispatchEvent(new Event('input', {bubbles: true}));
    const format = document.querySelector('select')!; format.value = 'json'; format.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(Object.values(f.state().interactionDrafts ?? {})[0]).toMatchObject({content: {format: 'json', editor: {fields: {answer: {value: '{unfinished'}}}}}));
    const restored = await f.open(); expect(restored.value).toBe('{unfinished'); expect(document.querySelector('select')!.value).toBe('json');
    f.branch('other'); expect((await f.open()).value).toBe(''); f.branch('main'); const next = await f.open();
    next.value = '{"ready":true}'; next.dispatchEvent(new Event('input', {bubbles: true}));
    next.closest('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(f.execute.mock.calls.some(([name]) => name === IndependentCallCommand.Respond)).toBe(true));
    await vi.waitFor(() => expect(Object.values(f.state().interactionDrafts)[0]).toMatchObject({content: null}));
});
it('retains local text on storage failure and requires explicit save retry before sending', async () => {
    const f = fixture(), input = await f.open(); f.repository.compareAndSetUIState.mockRejectedValueOnce(new Error('Disconnected'));
    input.value = 'Keep local'; input.dispatchEvent(new Event('input', {bubbles: true}));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-interaction-draft-retry]')?.hidden).toBe(false));
    input.closest('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(f.execute.mock.calls.some(([name]) => name === IndependentCallCommand.Respond)).toBe(false); expect(input.value).toBe('Keep local');
    document.querySelector<HTMLButtonElement>('[data-interaction-draft-retry]')!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-interaction-draft-retry]')!.hidden).toBe(true));
    expect((await f.open()).value).toBe('Keep local');
});
