import {expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {FlowInvocationCommand, type FlowInvocationInput} from '@itookit/llm-session/contracts';
import {InvocationOperations} from './invocation-operations';
const diagnostics = vi.hoisted(() => ({info: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', async original => {
    const actual = await original<typeof import('@itookit/common')>();
    return {...actual, createModuleLogger: (name: string) => name === 'flow-invocation-submission' ? diagnostics : actual.createModuleLogger(name)};
});
const input: FlowInvocationInput = {sessionId: 's', requestId: 'operation', execution: 'child', flowId: 'f', revision: 1, parameters: {text: 'PRIVATE_INPUT'}};
const accepted = () => ({...structuredClone(input), rootTaskId: 'root', executionSessionId: 'child'});
function fixture() {
    let saved: readonly OperationRecord[] = [];
    const execute = vi.fn(async (_name: string, _args?: unknown): Promise<any> => undefined);
    const open = () => new InvocationOperations(createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}}), {execute} as never, 's');
    return {open, execute, saved: () => saved};
}
it('registers the frozen request before dispatch and reopens by querying the original admission only', async () => {
    const f = fixture();
    f.execute.mockImplementation(async name => {
        if (name === FlowInvocationCommand.Invoke) {expect(f.saved()[0].input).toEqual({protocol: 'flow-invocation-v1', request: input}); throw new Error('Lost reply');}
        return [accepted()];
    });
    await expect(f.open().submit(input)).rejects.toThrow('Lost reply');
    expect(f.saved()[0].status).toBe('unknown');
    expect(await f.open().reconcile(input.requestId)).toMatchObject({status: 'accepted'});
    expect(f.saved()[0].status).toBe('accepted');
    expect(f.execute.mock.calls.filter(([name]) => name === FlowInvocationCommand.Invoke)).toHaveLength(1);
    expect(f.execute).toHaveBeenCalledWith(FlowInvocationCommand.List, {sessionId: 's'});
});
it('does not send if persistent registration fails or cancellation happens while it is saving', async () => {
    const execute = vi.fn(), broken = new InvocationOperations(createOperationLedger({save: async () => {throw new Error('Storage failed');}}), {execute} as never, 's');
    await expect(broken.submit(input)).rejects.toThrow('Storage failed'); expect(execute).not.toHaveBeenCalled();
    const abort = new AbortController(), ledger = createOperationLedger({save: async () => {abort.abort();}});
    await expect(new InvocationOperations(ledger, {execute} as never, 's').submit(input, abort.signal)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled(); expect(ledger.getSnapshot()[0].status).toBe('unknown');
});
it('keeps a route without a root unresolved and rejects a mismatched frozen receipt', async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(new Error('Lost'));
    await expect(f.open().submit(input)).rejects.toThrow();
    f.execute.mockResolvedValue([{...input, executionSessionId: 'child'}]);
    expect(await f.open().reconcile(input.requestId)).toMatchObject({status: 'unknown'});
    f.execute.mockResolvedValue([{...accepted(), parameters: {text: 'changed'}}]);
    await expect(f.open().reconcile(input.requestId)).rejects.toThrow('does not match');
    expect(f.saved()[0].status).toBe('unknown');
});
it('uses the same identity for an explicit retry after a read confirms no admitted execution', async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(new Error('Lost'));
    await expect(f.open().submit(input)).rejects.toThrow();
    f.execute.mockImplementation(async name => name === FlowInvocationCommand.List ? [] : accepted());
    await f.open().submit(input);
    expect(f.execute.mock.calls.map(([name]) => name)).toEqual([FlowInvocationCommand.Invoke, FlowInvocationCommand.List, FlowInvocationCommand.Invoke]);
    expect(f.execute.mock.calls[0][1]).toEqual(f.execute.mock.calls[2][1]);
});
it('does not resend a saved acceptance when the host record is temporarily unavailable', async () => {
    const f = fixture(); f.execute.mockResolvedValueOnce(accepted()); await f.open().submit(input);
    f.execute.mockResolvedValue([]); await f.open().submit(input);
    expect(f.execute.mock.calls.filter(([name]) => name === FlowInvocationCommand.Invoke)).toHaveLength(1);
    expect(f.saved()[0].status).toBe('accepted');
});

it('logs only operation metadata for failures without leaking arguments or backend messages', async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error('PRIVATE_BACKEND_ERROR'));
    await expect(f.open().submit(input)).rejects.toThrow('PRIVATE_BACKEND_ERROR');
    expect(diagnostics.warn).toHaveBeenCalledWith('Flow invocation submission', expect.objectContaining({
        operationId: input.requestId, stage: 'submit', outcome: 'failure', code: 'FLOW_INVOCATION_FAILED'}));
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toMatch(/PRIVATE_INPUT|PRIVATE_BACKEND_ERROR/);
});
