import {runInNewContext} from 'node:vm';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {sha256Hex} from '@itookit/common';
import {InputAssetCommand} from '@itookit/app-contracts';
import {DraftFilesCodec} from '../../llm-ui-adapter/src/services/DraftFilesCodec';
import {draftFileId} from '../../llm-ui-adapter/src/domain/draft-file-identity';
import {flowInputAssets} from '../../llm-ui-adapter/src/flows/input-assets';
import {fileBytes} from '../../llm-ui-adapter/src/utils/file-bytes';
import {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {StateService} from '../../llm-ui-adapter/src/services/StateService';
import {StateManager} from '../../llm-ui-adapter/src/shell/StateManager';
import type {IChatInputConfig, IChatInputPresenter} from '../../llm-ui-adapter/src/domain/ports/IChatInputPresenter';
import type {ConversationUIState} from '@itookit/llm-session/contracts';

const diagnostics = vi.hoisted(() => ({debug: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', async original => {
    const actual = await original<typeof import('@itookit/common')>();
    return {...actual, createModuleLogger: (name: string) => name === 'draft-files' ? diagnostics : actual.createModuleLogger(name)};
});

const cleanup: Array<() => void> = [];
afterEach(() => {cleanup.splice(0).forEach(close => close()); document.body.replaceChildren(); vi.restoreAllMocks();});
function storage() {
    const blobs = new Map<string, ArrayBuffer>();
    const port = {put: vi.fn(async (data: ArrayBuffer) => {const id = await sha256Hex(data); blobs.set(id, data.slice(0)); return id;}),
        read: vi.fn(async (id: string) => {if (!blobs.has(id)) throw Object.assign(new Error('Missing'), {code: 'ENOENT'}); return blobs.get(id)!.slice(0);})};
    return {blobs, port};
}

it('restores logical file identity and reuses the original Flow upload after a new browser File is constructed', async () => {
    const store = storage(), file = new File(['PRIVATE_BODY'], 'notes.txt', {type: 'text/plain'}), receipts = new Map<string, unknown>();
    const execute = vi.fn(async (command: string, input: any) => {
        if (command === InputAssetCommand.Inspect) return receipts.has(input.uploadId) ? {state: 'ready', reference: receipts.get(input.uploadId)} : {state: 'missing'};
        const asset = {kind: 'input', id: input.uploadId, mimeType: input.mimeType, bytes: input.bytes, sha256: input.sha256};
        receipts.set(input.uploadId, asset); return asset;
    });
    const assets = flowInputAssets({execute} as never), original = await assets.importFile(file);
    const records = await new DraftFilesCodec(store.port).encode([file]);
    const [restored] = await new DraftFilesCodec(store.port).decode(JSON.parse(JSON.stringify(records)));
    expect(restored).not.toBe(file); expect(draftFileId(restored)).toBe(draftFileId(file));
    expect(await assets.importFile(restored)).toEqual(original);
    expect(execute.mock.calls.filter(([command]) => command === InputAssetCommand.ImportFile)).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('PRIVATE_BODY'); expect(await fileBytes(restored)).toEqual(await fileBytes(file));
});

it('rejects damaged persisted bytes without writing a replacement and validates metadata before storage reads', async () => {
    const store = storage(), records = await new DraftFilesCodec(store.port).encode([new File(['original'], 'file.txt')]);
    store.blobs.set(records[0].id, new TextEncoder().encode('damaged').buffer);
    await expect(new DraftFilesCodec(store.port).decode(records)).rejects.toMatchObject({code: 'DRAFT_FILE_INTEGRITY'});
    const reads = store.port.read.mock.calls.length;
    await expect(new DraftFilesCodec(store.port).decode([{...records[0], fileId: 'invalid'}])).rejects.toMatchObject({code: 'DRAFT_FILE_METADATA_INVALID'});
    expect(store.port.read).toHaveBeenCalledTimes(reads); expect(store.port.put).toHaveBeenCalledOnce();
});

it('keeps empty files and the same logical identity when a failed binary write is retried', async () => {
    const store = storage(), file = new File([], 'empty.bin'), id = draftFileId(file), codec = new DraftFilesCodec(store.port);
    store.port.put.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(codec.encode([file])).rejects.toThrow('Storage unavailable');
    const records = await codec.encode([file]); expect(records[0]).toMatchObject({fileId: id, bytes: 0});
    expect((await new DraftFilesCodec(store.port).decode(records))[0].size).toBe(0);
});

it('preserves a restored draft token and rotates it for a later edit even when the user returns to identical text', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const input = new ChatInput(host, {onSend: async () => {}, onStop() {}}); cleanup.push(() => input.destroy());
    const file = new File(['selected'], 'file.txt'); input.restoreDraft('Original', [file], 'default');
    const config = input.getConfig(), token = config.draftToken, records = await new DraftFilesCodec(storage().port).encode([file]);
    expect(input.getConfig().draftToken).toBe(token);
    input.restoreDraftFiles([file], token); expect(input.getConfig().draftToken).toBe(token);
    const area = host.querySelector<HTMLTextAreaElement>('textarea')!;
    for (const text of ['Changed', 'Original']) {area.value = text; area.dispatchEvent(new Event('input'));}
    expect(input.getConfig().draftToken).not.toBe(token); expect(records[0].fileId).toBe(draftFileId(file));
});

it('does not rotate editing intent when an unchanged parameter form is confirmed again', () => {
    const host = document.createElement('div'); document.body.append(host);
    const target = {kind: 'flow' as const, id: 'worker', version: '1', digest: 'published'};
    const value = {target, targetId: 'worker', signature: {id: 'worker', revision: 1, digest: 'published'}, revision: 1, json: '{"count":0}'};
    const input = new ChatInput(host, {initialConfig: {target, input: value}, onSend: async () => {}, onStop() {}}); cleanup.push(() => input.destroy());
    const token = input.getConfig().draftToken; input.setConfig({input: {...value, revision: 2}});
    expect(input.getConfig().draftToken).toBe(token);
    input.setConfig({input: {...value, revision: 3, json: '{"count":1}'}}); expect(input.getConfig().draftToken).not.toBe(token);
});

function stateHarness() {
    const store = storage(); let state: ConversationUIState = {}; let revision = 0;
    const engine = {getManifest: async () => ({revision, uiState: structuredClone(state)}), compareAndSetUIState: async (_id: string, expected: number, patch: ConversationUIState) => {
        if (expected !== revision) throw Object.assign(new Error('Changed'), {code: 'SESSION_UI_STATE_CONFLICT'});
        state = {...state, ...structuredClone(patch), branchDrafts: {...state.branchDrafts, ...structuredClone(patch.branchDrafts)}}; revision++;
    }, getUIState: async () => state, saveSessionSettings: vi.fn(async () => {}), updateUIState: async (_id: string, patch: ConversationUIState) => {
        state = {...state, ...structuredClone(patch), branchDrafts: {...state.branchDrafts, ...structuredClone(patch.branchDrafts)}};
    }};
    const service = new StateService(engine as never); service.observeDraft('session', 'main', {}); service.observeDraft('session', 'review', {});
    const manager = () => {const value = new StateManager(service, {isGenerating: () => true}, 'session', id => id, 'main', new DraftFilesCodec(store.port)); cleanup.push(() => value.cleanup()); return value;};
    return {store, engine, service, manager, state: () => state};
}

it('persists Session draft files as references and replaces attachments when switching independent branch drafts', async () => {
    const f = stateHarness(), manager = f.manager(), host = document.createElement('div'); document.body.append(host);
    const input = new ChatInput(host, {onSend: async () => {}, onStop() {}}); cleanup.push(() => input.destroy()); manager.setChatInputGetter(() => input);
    const file = new File(['MAIN_PRIVATE'], 'main.txt'); input.restoreDraft('Main', [file], 'default');
    const token = input.getConfig().draftToken; await manager.saveInputConfiguration(input.getConfig());
    expect(f.state().branchDrafts?.main?.inputToken).toBe(token);
    expect(JSON.stringify(f.state())).not.toContain('MAIN_PRIVATE');
    await manager.switchDraftBranch('review'); expect(input.getDraftFiles()).toEqual([]);
    input.restoreDraft('Review', [new File(['Review'], 'review.txt')], 'default'); await manager.saveInputConfiguration(input.getConfig());
    await manager.switchDraftBranch('main'); expect(input.getConfig().draftToken).toBe(token);
    expect(input.getDraftFiles().map(file => file.name)).toEqual(['main.txt']); expect(draftFileId(input.getDraftFiles()[0])).toBe(draftFileId(file));
});

it('retains the source branch and input when destination draft bytes cannot be restored', async () => {
    const f = stateHarness(), records = await new DraftFilesCodec(f.store.port).encode([new File(['Target'], 'target.txt')]);
    await f.service.saveUIState('session', {collapse_states: {}, input_text: 'Target', input_files: records}, 'review');
    f.store.blobs.delete(records[0].id);
    const manager = f.manager(), config: IChatInputConfig = {text: 'Keep source', agentId: 'default', settings: {}};
    const restoreInput = vi.fn(), setConfig = vi.fn(); manager.setChatInputGetter(() => ({getConfig: () => config, restoreInput, setConfig,
        getDraftFiles: () => [], setLoading() {}} as unknown as IChatInputPresenter));
    await expect(manager.switchDraftBranch('review')).rejects.toMatchObject({code: 'DRAFT_FILE_MISSING'});
    expect(manager.getDraftBranch()).toBe('main'); expect(restoreInput).not.toHaveBeenCalled(); expect(setConfig).not.toHaveBeenCalled();
});


it('records safe stage and identity diagnostics and preserves results when the diagnostic sink throws', async () => {
    const store = storage(), file = new File(['SECRET_BODY'], 'SECRET_NAME.txt'), cause = new Error('SECRET_ERROR');
    store.port.put.mockRejectedValueOnce(cause);
    diagnostics.warn.mockImplementationOnce(() => {throw new Error('Sink unavailable');});
    await expect(new DraftFilesCodec(store.port).encode([file])).rejects.toBe(cause);
    const failure = diagnostics.warn.mock.calls.at(-1)!;
    expect(failure[1]).toMatchObject({operation: 'draft.files.encode', operationId: draftFileId(file), stage: 'persist', result: 'failure', code: 'DRAFT_FILE_FAILURE'});
    expect(JSON.stringify(failure)).not.toMatch(/SECRET_(BODY|NAME|ERROR)/);
    diagnostics.debug.mockImplementationOnce(() => {throw new Error('Sink unavailable');});
    const records = await new DraftFilesCodec(store.port).encode([file]); expect(records[0].bytes).toBe(11);
    expect(diagnostics.debug.mock.calls.at(-1)![1]).toMatchObject({result: 'success', operationId: draftFileId(file)});
});


it('accepts genuine cross-realm binary drafts while rejecting lookalike objects', async () => {
    const bytes = runInNewContext('new Uint8Array([102, 105, 108, 101]).buffer') as ArrayBuffer;
    expect(bytes instanceof ArrayBuffer).toBe(false);
    const record = {id: 'remote', name: 'remote.txt', type: 'text/plain', lastModified: 0, bytes: 4, sha256: await sha256Hex(new Uint8Array([102, 105, 108, 101]))};
    const codec = new DraftFilesCodec({put: vi.fn(), read: async () => bytes});
    const [file] = await codec.decode([record]); expect(new TextDecoder().decode(await fileBytes(file))).toBe('file');
    await expect(new DraftFilesCodec({put: vi.fn(), read: async () => ({byteLength: 4, [Symbol.toStringTag]: 'ArrayBuffer'}) as ArrayBuffer}).decode([record]))
        .rejects.toMatchObject({code: 'DRAFT_FILE_INTEGRITY'});
});
