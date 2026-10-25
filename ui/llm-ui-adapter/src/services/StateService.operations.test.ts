import {expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {StateService} from './StateService';
import type {ISessionRepository, ConversationUIState} from '@itookit/llm-session/contracts';
const diagnostics = vi.hoisted(() => ({debug: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', async original => {
    const actual = await original<typeof import('@itookit/common')>();
    return {...actual, createModuleLogger: (name: string) => name === 'workspace-operation-store' ? diagnostics : actual.createModuleLogger(name)};
});
const operation = (id: string, status: OperationRecord['status'] = 'submitting'): OperationRecord => ({
    context: {operationId: id, viewId: 'view'}, conversationId: 'session', kind: 'send', input: {text: `PRIVATE_${id}`}, status,
});
function fixture() {
    let revision = 0, state: ConversationUIState = {};
    const engine = {getManifest: vi.fn(async () => structuredClone({revision, uiState: state})),
        compareAndSetUIState: vi.fn(async (_id: string, expectedRevision: number, patch: ConversationUIState) => {
            if (expectedRevision !== revision) throw Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'});
            state = {...state, ...structuredClone(patch)}; revision++;
        })};
    const service = () => new StateService(engine as unknown as ISessionRepository);
    const ledger = (initial: readonly OperationRecord[] = []) => {const persistence = service(); return createOperationLedger({initial, save: records => persistence.saveOperations('session', records)});};
    return {engine, service, ledger, records: () => state.operationRecords as unknown as OperationRecord[]};
}
it('preserves independent concurrent view registrations and publishes the merged saved records', async () => {
    const f = fixture(), a = f.ledger(), b = f.ledger();
    await Promise.all([a.register(operation('a')), b.register(operation('b'))]);
    expect(f.records().map(record => record.context.operationId).sort()).toEqual(['a', 'b']);
    expect(f.engine.compareAndSetUIState.mock.calls.some(([, expectedRevision]) => expectedRevision === 0)).toBe(true);
    await a.settle({operationId: 'a', status: 'accepted'});
    await b.settle({operationId: 'b', status: 'accepted'});
    expect(f.records().map(record => record.status)).toEqual(['accepted', 'accepted']);
    expect(b.getSnapshot().map(record => record.status)).toEqual(['accepted', 'accepted']);
});
it('retains a saved terminal receipt when another view submits an old unknown snapshot', async () => {
    const f = fixture(), a = f.ledger(); await a.register(operation('a'));
    const stale = f.ledger([operation('a', 'unknown')]); await a.settle({operationId: 'a', status: 'accepted'});
    await stale.register(operation('b'));
    expect(f.records()[0].status).toBe('accepted'); expect(stale.getSnapshot()[0].status).toBe('accepted');
});
it('recognizes a committed write with a lost reply without another write or registration', async () => {
    const f = fixture(), original = f.engine.compareAndSetUIState.getMockImplementation()!;
    f.engine.compareAndSetUIState.mockImplementationOnce(async (...args) => {await original(...args); throw new Error('PRIVATE_ERROR');});
    const ledger = f.ledger(); await ledger.register(operation('a'));
    expect(f.records()).toEqual([operation('a')]); expect(ledger.getSnapshot()).toEqual([operation('a')]);
    expect(f.engine.compareAndSetUIState).toHaveBeenCalledOnce();
});
it('does not acknowledge an uncommitted write failure or discard the last saved local snapshot', async () => {
    const f = fixture(), ledger = f.ledger([operation('a')]), error = Object.assign(new Error('Unavailable'), {code: 'EIO'});
    f.engine.compareAndSetUIState.mockRejectedValue(error);
    await expect(ledger.register(operation('b'))).rejects.toBe(error);
    expect(ledger.getSnapshot()).toEqual([operation('a')]); expect(f.engine.compareAndSetUIState).toHaveBeenCalledOnce();
});
it('bounds optimistic retries and never falls back to unconditional overwrite', async () => {
    const f = fixture(), ledger = f.ledger(); f.engine.compareAndSetUIState.mockRejectedValue(Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'}));
    await expect(ledger.register(operation('a'))).rejects.toMatchObject({code: 'OPERATION_SAVE_CONFLICT'});
    expect(f.engine.compareAndSetUIState.mock.calls.length).toBeLessThanOrEqual(8);
    expect(f.engine.compareAndSetUIState.mock.calls.every(([, expectedRevision]) => Number.isSafeInteger(expectedRevision))).toBe(true);
    expect(ledger.getSnapshot()).toEqual([]);
});
it('rejects conflicting frozen input without replacing the saved operation', async () => {
    const f = fixture(), a = f.ledger(); await a.register(operation('a'));
    await expect(f.service().saveOperations('session', [{...operation('a'), input: {text: 'different'}}]))
        .rejects.toMatchObject({code: 'OPERATION_IDENTITY_CONFLICT'});
    expect(f.records()).toEqual([operation('a')]); expect(f.engine.compareAndSetUIState).toHaveBeenCalledOnce();
});

it('rejects a host without conditional-write support or a valid revision before writing', async () => {
    const f = fixture(), unsupported = {...f.engine, compareAndSetUIState: undefined};
    await expect(new StateService(unsupported as unknown as ISessionRepository).saveOperations('session', [operation('a')]))
        .rejects.toMatchObject({code: 'OPERATION_STORE_UNAVAILABLE'});
    f.engine.getManifest.mockResolvedValueOnce({revision: undefined as unknown as number, uiState: {}});
    await expect(f.service().saveOperations('session', [operation('a')])).rejects.toMatchObject({code: 'OPERATION_STORE_UNAVAILABLE'});
    expect(f.engine.compareAndSetUIState).not.toHaveBeenCalled();
});
it('emits safe diagnostics without payloads and does not let a throwing sink acknowledge failed storage', async () => {
    const f = fixture(), failure = Object.assign(new Error('PRIVATE_ERROR'), {code: 'EIO'});
    f.engine.compareAndSetUIState.mockRejectedValueOnce(failure);
    diagnostics.warn.mockImplementationOnce(() => {throw new Error('Sink unavailable');});
    await expect(f.service().saveOperations('session', [operation('a')])).rejects.toBe(failure);
    const diagnostic = diagnostics.warn.mock.calls.at(-1)!;
    expect(diagnostic[1]).toMatchObject({operation: 'workspace.operations.save', stage: 'write-receipt', result: 'failure', code: 'EIO'});
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    diagnostics.debug.mockImplementationOnce(() => {throw new Error('Sink unavailable');});
    expect(await f.service().saveOperations('session', [operation('a')])).toEqual([operation('a')]);
});
