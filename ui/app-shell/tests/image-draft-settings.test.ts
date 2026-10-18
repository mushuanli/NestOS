// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {DraftDataCodec} from '../../llm-ui-adapter/src/shell/drafts/session-draft-data';
import {imageFileState, setImageFileState} from '../../llm-ui-adapter/src/components/input/image-file-state';
import {inheritDraftPreferences} from '../../llm-ui-adapter/src/shell/drafts/draft-preferences';
import {renderAgentImageSettings, readAgentImageSettings} from '../../llm-settings-ui/src/editors/agent-image-settings';

it('persists the original resource and current crop separately from the derived image', async () => {
    const bytes = new Map<string, ArrayBuffer>(); let id = 0;
    const attachments = {put: async (value: ArrayBuffer) => {const key = String(++id); bytes.set(key, value); return key;}, read: async (key: string) => bytes.get(key)!};
    const original = new File(['original larger image'], 'original.png', {type: 'image/png'}), derived = new File(['small'], 'original.png', {type: 'image/png'});
    setImageFileState(derived, {id: 'image-1', revision: 2, original, resizeKey: '{"mode":"max-edge","maxEdge":1024}',
        spec: {version: 1, selection: {kind: 'rect', x: 0.1, y: 0.2, width: 0.5, height: 0.6}}});
    const data = await new DraftDataCodec(attachments).encode({text: 'Keep', agentId: 'default', settings: {}}, [derived]);
    const restored = await new DraftDataCodec(attachments).decode(data), state = imageFileState(restored.files[0]);
    expect(restored.files[0].size).toBe(derived.size); expect(state.original.size).toBe(original.size);
    expect(state).toMatchObject({id: 'image-1', revision: 2, spec: {selection: {kind: 'rect', x: 0.1}}});
});
it('carries valid image preferences into remote project drafts without carrying model settings', () => {
    const next = inheritDraftPreferences({text: 'target', agentId: 'remote:a', settings: {}},
        {agentId: 'remote:a', settings: {imageResize: {mode: 'max-edge', maxEdge: 2048}, connectionId: 'local'}},
        [{id: 'remote:a', name: 'Remote'}], [], true);
    expect(next.settings.imageResize).toEqual({mode: 'max-edge', maxEdge: 2048}); expect(next.settings.connectionId).toBeUndefined();
});
it('keeps agent defaults as inheritance rather than pinning the default number', () => {
    const host = document.createElement('div'); host.innerHTML = renderAgentImageSettings();
    expect(readAgentImageSettings(host)).toBeUndefined();
    host.querySelector<HTMLSelectElement>('[name=imageResizeMode]')!.value = 'max-edge';
    host.querySelector<HTMLInputElement>('[name=imageMaxEdge]')!.value = '2048';
    expect(readAgentImageSettings(host)).toEqual({resize: {mode: 'max-edge', maxEdge: 2048}});
    host.querySelector<HTMLInputElement>('[name=imageMaxEdge]')!.value = '-1'; expect(() => readAgentImageSettings(host)).toThrow();
});
