import {expect, it, vi} from 'vitest';
import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import type {ICommandBus} from '../src/contracts/command-bus';
import {IndependentCallCommand} from '../src/contracts/independent-calls';
import {IndependentCallResponses} from '../src/session/independent-call-responses';
const query = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'root',
    targetTaskId: 'worker', interactionId: 'ask', requestId: 'answer'};
function fixture() {
    const handlers = new Map<string, (value: any) => Promise<any>>();
    const root = {id: 'root', sessionId: 'child', rootTaskId: 'root', program: {kind: 'agent.loop'}} as TaskRecord;
    const target = {...root, id: 'worker', parentTaskId: 'root', interactions: {ask: {id: 'ask', status: 'pending'}}} as TaskRecord;
    const resolve = vi.fn(async () => root), respondInteraction = vi.fn(), canWrite = vi.fn(async () => true);
    const readTaskInteractionResponseReceipt = vi.fn(async () => ({requestId: 'answer', taskId: 'worker', interactionId: 'ask', resolvedAt: 1}));
    const logger = {info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn()};
    const commands = {register: (name: string, handler: any) => handlers.set(name, handler)} as unknown as ICommandBus;
    const kernel = {respondInteraction, readTaskInteractionResponseReceipt, inspectSession: async () => ({attachTask: async (id: string) => ({status: async () => ({task: id === 'worker' ? target : root})})})} as unknown as Kernel;
    new IndependentCallResponses({kernel, commands, logger, resolve, canWrite}).register();
    return {handlers, respondInteraction, readTaskInteractionResponseReceipt, target, logger, canWrite, resolve};
}
it('routes an identified answer and queries without write permission or another dispatch', async () => {
    const f = fixture();
    expect(await f.handlers.get(IndependentCallCommand.Respond)!({...query, value: 'PRIVATE ANSWER'})).toMatchObject({...query, receipt: {requestId: 'answer'}});
    expect(f.respondInteraction).toHaveBeenCalledWith('child', 'worker', {interactionId: 'ask', value: 'PRIVATE ANSWER'}, {requestId: 'answer'});
    f.canWrite.mockClear(); await f.handlers.get(IndependentCallCommand.ResponseReceipt)!(query);
    expect(f.canWrite).not.toHaveBeenCalled(); expect(f.respondInteraction).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain('PRIVATE ANSWER');
});
it.each([undefined, NaN, {nested: undefined}, new Date(), [undefined], Object.assign(new Array(1), {extra: true})])('rejects non-JSON answers before resolving the call: %s', async value => {
    const f = fixture(); await expect(f.handlers.get(IndependentCallCommand.Respond)!({...query, value})).rejects.toMatchObject({code: 'CALL_RESPONSE_VALUE_INVALID'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.respondInteraction).not.toHaveBeenCalled();
});
it('rejects another execution tree, missing interactions, and mismatched receipts', async () => {
    const f = fixture(); f.target.rootTaskId = 'another';
    await expect(f.handlers.get(IndependentCallCommand.Respond)!({...query, value: true})).rejects.toMatchObject({code: 'CALL_INTERACTION_SCOPE_MISMATCH'});
    f.target.rootTaskId = 'root';
    await expect(f.handlers.get(IndependentCallCommand.Respond)!({...query, interactionId: 'missing', value: true})).rejects.toMatchObject({code: 'CALL_INTERACTION_NOT_FOUND'});
    f.readTaskInteractionResponseReceipt.mockResolvedValueOnce({requestId: 'other', taskId: 'worker', interactionId: 'ask', resolvedAt: 1});
    await expect(f.handlers.get(IndependentCallCommand.ResponseReceipt)!(query)).rejects.toMatchObject({code: 'CALL_RESPONSE_RECEIPT_MISMATCH'});
    expect(f.respondInteraction).not.toHaveBeenCalled();
});
it('keeps missing evidence unknown and rejects payloads on the read-only query', async () => {
    const f = fixture(); f.readTaskInteractionResponseReceipt.mockResolvedValueOnce(undefined as never);
    expect(await f.handlers.get(IndependentCallCommand.ResponseReceipt)!(query)).toEqual(query);
    await expect(f.handlers.get(IndependentCallCommand.ResponseReceipt)!({...query, value: 'PRIVATE'})).rejects.toMatchObject({code: 'CALL_RESPONSE_INVALID'});
    expect(f.respondInteraction).not.toHaveBeenCalled(); expect(f.canWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('PRIVATE');
});
it('reads complete interaction details without answers, writing permission, or another dispatch', async () => {
    const f = fixture(); f.target.interactions.ask = {id: 'ask', kind: 'approval', prompt: 'Full prompt', payload: {command: 'Review me'},
        requestedAt: 1, status: 'resolved', response: 'PRIVATE ANSWER', responseRequestId: 'answer', resolvedAt: 2};
    const result = await f.handlers.get(IndependentCallCommand.Interaction)!(query);
    expect(result).toEqual({...query, interaction: {id: 'ask', kind: 'approval', prompt: 'Full prompt', payload: {command: 'Review me'}, requestedAt: 1, status: 'resolved'}});
    expect(f.canWrite).not.toHaveBeenCalled(); expect(f.respondInteraction).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('PRIVATE ANSWER');
    f.target.interactions.ask.prompt = 'x'.repeat(1024 * 1024);
    await expect(f.handlers.get(IndependentCallCommand.Interaction)!(query)).rejects.toMatchObject({code: 'CALL_INTERACTION_DETAIL_TOO_LARGE'});
});
