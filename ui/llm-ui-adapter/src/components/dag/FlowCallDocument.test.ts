// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {FlowCallDocument} from './FlowCallDocument';
vi.mock('./FlowDocuments', () => ({FlowDocuments: class {
    mount(root: HTMLElement, _id: string, _title: string, content: string) {root.textContent = content;}
    destroy() {}
}, flowRequestMarkdown: () => 'Request'}));

it('stops automatic result reads after failure and retries only on the explicit control', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('Result storage offline')).mockResolvedValue({root: {task: {id: 'root', sessionId: 'child', output: 'Recovered'}}});
    const root = document.createElement('div'); document.body.append(root);
    const view = new FlowCallDocument(root, {execute} as never);
    const call = {status: 'completed', summary: 'Summary', input: {request: {source: {kind: 'arguments', value: {}}}},
        receipt: {operationId: 'original', executionSessionId: 'child', execution: {taskId: 'root'}}} as never;
    try {
        view.update(call); await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-flow-result-retry]')!.hidden).toBe(false));
        view.update(call); view.update(call); expect(execute).toHaveBeenCalledOnce();
        root.querySelector<HTMLButtonElement>('[data-flow-result-retry]')!.click();
        await vi.waitFor(() => expect(root.textContent).toContain('Recovered'));
        expect(execute).toHaveBeenLastCalledWith(FlowCommand.RunGet, {sessionId: 'child', taskId: 'root'});
        expect(root.querySelector<HTMLButtonElement>('[data-flow-result-retry]')!.hidden).toBe(true);
        view.update(call); expect(execute).toHaveBeenCalledTimes(2);
    } finally {view.destroy(); root.remove();}
});
