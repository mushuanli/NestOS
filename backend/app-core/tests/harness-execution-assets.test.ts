import {expect, it, vi} from 'vitest';
import {sha256Hex} from '@itookit/llm-context/digest';
import type {HarnessAssetAttachment, HarnessExecutionRequest} from '@itookit/kernel-adapters/contracts';
import {createHarnessExecutionProvider} from '../src/projects/harness-execution';
import {complete, fixture, request} from './harness-execution-fixture';

async function setup(text = '\ufeffPrivate selected file') {
    const f = fixture(), bytes = new TextEncoder().encode(text);
    f.profile.capabilities.attachments = ['text', 'image'];
    const file: HarnessAssetAttachment = {kind: 'asset', name: 'notes.txt', asset: {
        kind: 'input', id: '12345678-1234-1234-1234-123456789012', mimeType: 'text/plain', bytes: bytes.length, sha256: await sha256Hex(bytes),
    }};
    const read = vi.fn(async () => bytes), input: HarnessExecutionRequest = {...request, attachments: [file]};
    const provider = createHarnessExecutionProvider(f.connections, {readTaskAsset: read, pollMs: 5, cancelTimeoutMs: 100, stateForCleanup: async () => f.state});
    return {...f, bytes, read, input, file, provider};
}

it('resolves selected text bytes under the actual consumer identity and sends portable data only', async () => {
    const f = await setup(); complete(f); const original = structuredClone(f.input);
    await f.provider.execute(f.input, f.context);
    expect(f.read).toHaveBeenCalledWith(f.file.asset, expect.objectContaining({sessionId: f.context.sessionId, taskId: f.context.taskId, effectId: f.context.effectId, operationId: f.context.effectId}));
    expect(f.client.turn).toHaveBeenCalledWith('claude', 'native-session', request.prompt, expect.objectContaining({attachments: [
        {kind: 'text', name: 'notes.txt', mimeType: 'text/plain', content: '\ufeffPrivate selected file'},
    ]}));
    expect(f.input).toEqual(original);
    expect(JSON.stringify(vi.mocked(f.context.emit!).mock.calls)).not.toContain('Private selected file');
});

it.each(['changed', 'scope', 'missing', 'storage'] as const)('rejects %s assets before native create or turn with a specific safe reason', async failure => {
    const f = await setup();
    if (failure === 'changed') f.read.mockResolvedValueOnce(new TextEncoder().encode('changed'));
    else f.read.mockRejectedValueOnce(Object.assign(new Error('Sensitive file path or body'), {code: failure === 'scope' ? 'ASSET_FLOW_MISMATCH' : failure === 'storage' ? 'EACCES' : 'INPUT_ASSET_MISSING'}));
    const code = failure === 'changed' ? 'HARNESS_ASSET_INTEGRITY' : failure === 'scope' ? 'ASSET_FLOW_MISMATCH' : failure === 'storage' ? 'HARNESS_ASSET_STORAGE_DENIED' : 'INPUT_ASSET_MISSING';
    await expect(f.provider.execute(f.input, f.context)).rejects.toMatchObject({code, executionOutcome: 'not-started'});
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    const logs = JSON.stringify(vi.mocked(f.context.emit!).mock.calls);
    expect(logs).toContain(code); expect(logs).not.toContain('Sensitive file path');
});

it.each(['capability', 'size', 'format'] as const)('rejects unsupported %s before reading or creating any native resource', async failure => {
    const f = await setup();
    if (failure === 'capability') f.profile.capabilities.attachments = [];
    if (failure === 'size') f.file.asset.bytes = 65537;
    if (failure === 'format') f.file.asset.mimeType = 'application/pdf';
    const code = failure === 'capability' ? 'HARNESS_ATTACHMENT_KIND_UNSUPPORTED' : failure === 'size' ? 'HARNESS_ATTACHMENT_TEXT_LIMIT' : 'HARNESS_ATTACHMENT_MEDIA_UNSUPPORTED';
    await expect(f.provider.execute(f.input, f.context)).rejects.toMatchObject({code, executionOutcome: 'not-started'});
    expect(f.read).not.toHaveBeenCalled(); expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
});

it.each(['reconcile', 'cancel'] as const)('can %s the original uncertain turn after selected assets become unavailable', async operation => {
    const f = await setup(), turn = vi.mocked(f.client.turn).getMockImplementation()!;
    vi.mocked(f.client.turn).mockImplementationOnce(async (...args) => {await turn(...args); throw Object.assign(new Error('Lost acknowledgement'), {outcome: 'unknown'});});
    await expect(f.provider.execute(f.input, f.context)).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
    f.read.mockRejectedValue(new Error('Selected asset was removed')); complete(f);
    if (operation === 'reconcile') expect(await f.provider.reconcile(f.input, f.context)).toMatchObject({status: 'completed'});
    else expect(await f.provider.cancel(f.input, f.context)).toMatchObject({status: 'stopped', cleanup: 'confirmed'});
    expect(f.read).toHaveBeenCalledOnce(); expect(f.client.create).toHaveBeenCalledOnce(); expect(f.client.turn).toHaveBeenCalledOnce();
});

it('waits for in-flight asset reading and connection release before confirming cleanup', async () => {
    const f = await setup(); let finish!: (bytes: Uint8Array) => void, confirmed = false;
    f.read.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const running = f.provider.execute(f.input, f.context).catch(error => error);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce()); f.controller.abort();
    const cancellation = f.provider.cancel(f.input, f.context).then(result => {confirmed = true; return result;});
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(confirmed).toBe(false); expect(f.release).not.toHaveBeenCalled();
    finish(f.bytes); await running;
    expect(await cancellation).toMatchObject({status: 'stopped', cleanup: 'confirmed', evidence: {kind: 'not-started'}});
    expect(f.release).toHaveBeenCalledTimes(f.connections.acquire.mock.calls.length); expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
});

it.each(['invalid-utf8', 'unsafe-name', 'count', 'digest'] as const)('rejects malformed %s attachment input without native mutation', async failure => {
    const f = await setup();
    if (failure === 'invalid-utf8') {
        const bytes = new Uint8Array([0xff]); f.read.mockResolvedValue(bytes);
        Object.assign(f.file.asset, {bytes: bytes.length, sha256: await sha256Hex(bytes)});
    }
    if (failure === 'unsafe-name') f.file.name = '../notes.txt';
    if (failure === 'count') f.input.attachments = Array.from({length: 6}, (_, index) => ({...f.file, name: `file-${index}.txt`}));
    if (failure === 'digest') f.file.asset.sha256 = '0'.repeat(64);
    const code = { 'invalid-utf8': 'HARNESS_ATTACHMENT_TEXT_ENCODING', 'unsafe-name': 'HARNESS_ATTACHMENT_NAME_INVALID',
        count: 'HARNESS_ATTACHMENT_COUNT_LIMIT', digest: 'HARNESS_ASSET_INTEGRITY' }[failure];
    await expect(f.provider.execute(f.input, f.context)).rejects.toMatchObject({code, executionOutcome: 'not-started'});
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    if (failure === 'unsafe-name' || failure === 'count') expect(f.read).not.toHaveBeenCalled();
});

it('rejects changed attachment identity when reconciling an existing execution', async () => {
    const f = await setup(); complete(f); await f.provider.execute(f.input, f.context);
    const changed = structuredClone(f.input);
    (changed.attachments![0] as HarnessAssetAttachment).asset.sha256 = '0'.repeat(64);
    expect(await f.provider.reconcile(changed, f.context)).toMatchObject({status: 'unknown', code: 'JOURNAL_CONFLICT'});
    expect(f.read).toHaveBeenCalledOnce(); expect(f.client.create).toHaveBeenCalledOnce(); expect(f.client.turn).toHaveBeenCalledOnce();
});

it.each([['EACCES', 'HARNESS_ASSET_STORAGE_DENIED'], ['ENOENT', 'HARNESS_ASSET_MISSING']])('preserves a wrapped %s storage classification without exposing the cause', async (storageCode, code) => {
    const f = await setup();
    f.read.mockRejectedValue(Object.assign(new Error('Private backend location'), {code: 'MEDIA_ASSET_READ_FAILED', storageCode}));
    await expect(f.provider.execute(f.input, f.context)).rejects.toMatchObject({code, executionOutcome: 'not-started'});
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(f.context.emit!).mock.calls)).not.toContain('Private backend');
});
