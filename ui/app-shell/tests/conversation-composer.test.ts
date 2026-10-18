// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import type {ConversationControls} from '@itookit/ui-common';
import {ConversationComposer} from '../../llm-ui-adapter/src/shell/drafts/conversation-composer';
import {imageFileState, setImageFileState} from '../../llm-ui-adapter/src/components/input/image-file-state';
function host() {
    const assets = new Map<string, ArrayBuffer>(); let serial = 0, drop = false;
    let state = {revision: '0', data: '', acceptedOperationIds: [] as string[]};
    const controls = {
        readComposerDraft: async () => structuredClone(state),
        putComposerAsset: async (bytes: ArrayBuffer) => {const id = String(++serial); assets.set(id, bytes); return id;},
        readComposerAsset: async (id: string) => assets.get(id)!,
        saveComposerDraft: vi.fn(async (data: string, revision: string, operationId: string) => {
            if (revision !== state.revision) throw Object.assign(new Error('ECONFLICT'), {code: 'ECONFLICT'});
            state = {data, revision: String(++serial), acceptedOperationIds: [...state.acceptedOperationIds, operationId]};
            if (drop) {drop = false; throw new Error('Response lost');} return structuredClone(state);
        }),
    } as unknown as ConversationControls;
    return {controls, loseResponse: () => {drop = true;}, state: () => state};
}
it('reopens originals, image recipes and resize preferences without sending the original to a harness', async () => {
    const peer = host(), first = ConversationComposer.create(peer.controls)!; await first.restore();
    const original = new File(['original-pixels'], 'photo.png', {type: 'image/png'}), file = new File(['derived'], original.name, {type: original.type});
    setImageFileState(file, {id: 'photo', revision: 2, original, spec: {version: 1, selection: {kind: 'rect', x: 0, y: 0, width: 0.5, height: 0.5}}, resizeKey: '{"mode":"max-edge","maxEdge":1024}'});
    const config = {text: 'Inspect', agentId: 'remote:fixture', settings: {imageResize: {mode: 'original' as const}}};
    await first.save(config, [file]);
    const restored = await ConversationComposer.create(peer.controls)!.restore();
    expect(restored.config).toEqual(config); expect(restored.files[0].size).toBe(file.size);
    expect(imageFileState(restored.files[0])).toMatchObject({id: 'photo', revision: 2, spec: {selection: {kind: 'rect'}}});
    expect(imageFileState(restored.files[0]).original.size).toBe(original.size);
});
it('queries a lost save acknowledgement and refuses stale views without replaying a write', async () => {
    const peer = host(), first = ConversationComposer.create(peer.controls)!, stale = ConversationComposer.create(peer.controls)!;
    await first.restore(); await stale.restore(); peer.loseResponse();
    await first.save({text: 'Keep', agentId: 'a', settings: {}}, []);
    expect(peer.controls.saveComposerDraft).toHaveBeenCalledTimes(1);
    await expect(stale.save({text: 'Overwrite', agentId: 'a', settings: {}}, [])).rejects.toThrow('ECONFLICT');
    expect(JSON.parse(peer.state().data).config.text).toBe('Keep');
});
it('persists submission correlation until accepted and retains a newly edited draft separately', async () => {
    const peer = host(), first = ConversationComposer.create(peer.controls)!; await first.restore();
    const config = {text: 'Submitted', agentId: 'a', settings: {}};
    await first.submit(config, [], 'submission-1');
    const reopened = ConversationComposer.create(peer.controls)!; await reopened.restore();
    expect(reopened.hasSubmission).toBe(true); expect(reopened.submissionId).toBe('submission-1');
    await reopened.save({...config, text: 'New input'}, []);
    expect(JSON.parse(peer.state().data).remoteSubmission).toMatchObject({id: 'submission-1'});
    const restored = await ConversationComposer.create(peer.controls)!.restore();
    expect(restored.submission).toMatchObject({text: 'Submitted', clearText: false});
    reopened.accepted(); await reopened.save({...config, text: ''}, []);
    expect(JSON.parse(peer.state().data).config.text).toBe('');
});

it('keeps an unconfirmed save pending and queries it before accepting another write', async () => {
    const peer = host(), composer = ConversationComposer.create(peer.controls)!; await composer.restore();
    const read = peer.controls.readComposerDraft!; let offline = true;
    peer.controls.readComposerDraft = async () => {if (offline) throw new Error('Offline'); return read();};
    peer.loseResponse();
    await expect(composer.save({text: 'First', agentId: 'a', settings: {}}, [])).rejects.toThrow('Response lost');
    await expect(composer.save({text: 'Second', agentId: 'a', settings: {}}, [])).rejects.toThrow();
    expect(peer.controls.saveComposerDraft).toHaveBeenCalledTimes(1);
    offline = false; await composer.save({text: 'Second', agentId: 'a', settings: {}}, []);
    expect(peer.controls.saveComposerDraft).toHaveBeenCalledTimes(2); expect(JSON.parse(peer.state().data).config.text).toBe('Second');
});

it('recovers from a definite CAS rejection after an explicit reload', async () => {
    const peer = host(), first = ConversationComposer.create(peer.controls)!, stale = ConversationComposer.create(peer.controls)!;
    await first.restore(); await stale.restore();
    await first.save({text: 'Other window', agentId: 'a', settings: {}}, []);
    await expect(stale.save({text: 'Stale', agentId: 'a', settings: {}}, [])).rejects.toMatchObject({code: 'ECONFLICT'});
    await stale.restore(); await stale.save({text: 'Explicit replacement', agentId: 'a', settings: {}}, []);
    expect(JSON.parse(peer.state().data).config.text).toBe('Explicit replacement');
});
it('preserves a new draft edited back to the submitted text across reopening', async () => {
    const peer = host(), composer = ConversationComposer.create(peer.controls)!; await composer.restore();
    const config = {text: 'Same text', agentId: 'a', settings: {}};
    await composer.submit(config, [], 'operation');
    await composer.save({...config, text: 'Different'}, []); await composer.save(config, []);
    const restored = await ConversationComposer.create(peer.controls)!.restore();
    expect(restored.config?.text).toBe('Same text'); expect(restored.submission?.clearText).toBe(false);
});
it('retains the frozen attachment identity when the editable attachment changes', async () => {
    const peer = host(), composer = ConversationComposer.create(peer.controls)!; await composer.restore();
    const config = {text: 'Submitted', agentId: 'a', settings: {}}, first = new File(['first'], 'same.txt');
    await composer.submit(config, [first], 'operation');
    await composer.save({...config, text: 'Follow-up'}, [new File(['replacement'], 'same.txt')]);
    const restored = await ConversationComposer.create(peer.controls)!.restore();
    expect(restored.submission?.files).toEqual([]); expect(restored.files).toHaveLength(1);
    expect(JSON.parse(JSON.parse(peer.state().data).remoteSubmission.base).files[0].id)
        .not.toBe(JSON.parse(peer.state().data).files[0].id);
});

it('orders a frozen submission before newer edits even when its attachment encoding is slow', async () => {
    const peer = host(), composer = ConversationComposer.create(peer.controls)!; await composer.restore();
    const put = peer.controls.putComposerAsset!; let finish!: () => void;
    peer.controls.putComposerAsset = async data => {await new Promise<void>(resolve => {finish = resolve;}); return put(data);};
    const config = {text: 'Submitted', agentId: 'a', settings: {}};
    const submitting = composer.submit(config, [new File(['slow'], 'photo.txt')], 'operation');
    const saving = composer.save({...config, text: 'Typed during upload'}, []);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); finish(); await submitting; await saving;
    const restored = await ConversationComposer.create(peer.controls)!.restore();
    expect(restored.config?.text).toBe('Typed during upload'); expect(restored.submission?.text).toBe('Submitted');
    expect(restored.submission?.clearText).toBe(false);
});
