import {afterEach, expect, it, vi} from 'vitest';
import {ContentTransferCommand, type CreateChildInput} from '@itookit/llm-session/contracts';
import {createChildWithReceipt} from './child-creation';
const logs = vi.hoisted(() => ({info: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', () => ({createModuleLogger: () => logs}));
afterEach(() => {vi.clearAllMocks();});
const input: CreateChildInput = {sessionId: 'parent', requestId: 'original', title: 'PRIVATE_TITLE', transfer: {sessionId: 'parent', id: 'material'}};
const created = {parentSessionId: 'parent', requestId: 'original', sessionId: 'child', status: 'created'};
const failure = Object.assign(new Error('PRIVATE_ERROR'), {code: 'ETIMEDOUT'});
const port = (execute: unknown) => ({execute} as never);
it('returns normal creation without requesting a receipt', async () => {
    const execute = vi.fn(async () => ({sessionId: 'child'}));
    expect(await createChildWithReceipt(port(execute), input)).toEqual({sessionId: 'child'});
    expect(execute).toHaveBeenCalledTimes(1);
});
it('recovers a lost reply with a read of the same frozen request and never repeats creation', async () => {
    const execute = vi.fn(async name => {if (name === ContentTransferCommand.CreateChild) throw failure; return created;});
    expect(await createChildWithReceipt(port(execute), input)).toEqual({sessionId: 'child'});
    expect(execute.mock.calls.map(call => call[0])).toEqual([ContentTransferCommand.CreateChild, ContentTransferCommand.ChildReceipt]);
    expect(execute).toHaveBeenLastCalledWith(ContentTransferCommand.ChildReceipt, input);
    expect(JSON.stringify([...logs.info.mock.calls, ...logs.warn.mock.calls])).not.toMatch(/PRIVATE_TITLE|PRIVATE_ERROR|material/);
});
it.each(['unknown', 'reserved'])('retains the original failure when the receipt is %s', async status => {
    const execute = vi.fn(async name => {if (name === ContentTransferCommand.CreateChild) throw failure; return {...created, status};});
    await expect(createChildWithReceipt(port(execute), input)).rejects.toBe(failure); expect(execute).toHaveBeenCalledTimes(2);
});
it.each([{requestId: 'other'}, {parentSessionId: 'other'}, {sessionId: '../other'}, {status: 'running'}])('rejects a mismatched receipt: %j', async patch => {
    const execute = vi.fn(async name => {if (name === ContentTransferCommand.CreateChild) throw failure; return {...created, ...patch};});
    await expect(createChildWithReceipt(port(execute), input)).rejects.toMatchObject({code: 'CONTENT_CHILD_RECEIPT_MISMATCH'});
});
it('retains the original creation failure when receipt inspection itself fails', async () => {
    const execute = vi.fn(async name => {if (name === ContentTransferCommand.CreateChild) throw failure; throw new Error('PRIVATE_LOOKUP');});
    await expect(createChildWithReceipt(port(execute), input)).rejects.toBe(failure);
    expect(JSON.stringify([...logs.info.mock.calls, ...logs.warn.mock.calls])).not.toContain('PRIVATE_LOOKUP');
});
it('does not navigate or reconcile after the owning dialog was closed', async () => {
    const controller = new AbortController(), execute = vi.fn(async () => {controller.abort(); throw failure;});
    await expect(createChildWithReceipt(port(execute), input, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(execute).toHaveBeenCalledTimes(1);
});
it('freezes the request across a suspended creation response', async () => {
    const supplied = structuredClone(input); let reject!: (error: unknown) => void;
    const execute = vi.fn(async name => name === ContentTransferCommand.CreateChild ? new Promise((_resolve, no) => {reject = no;}) : created);
    const pending = createChildWithReceipt(port(execute), supplied); supplied.title = 'Changed'; reject(failure);
    expect(await pending).toEqual({sessionId: 'child'});
    expect(execute).toHaveBeenLastCalledWith(ContentTransferCommand.ChildReceipt, input);
});
it('isolates diagnostic failures from the durable receipt', async () => {
    logs.info.mockImplementationOnce(() => {throw new Error('Private logger failure');});
    const execute = vi.fn(async () => ({sessionId: 'child'}));
    expect(await createChildWithReceipt(port(execute), input)).toEqual({sessionId: 'child'});
});
