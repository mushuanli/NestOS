// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {arrayBufferToBase64, sha256Hex, t} from '@itookit/common';
import {createOperationLedger} from '@itookit/llm-ui';
import {RpcPeer} from '@itookit/app-transport/application';
import type {ConversationCommandOutput, ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
import {NativeCommandOutput} from '../../llm-ui-adapter/src/components/history/NativeCommandOutput';
import {RemoteConversationEditor} from '../../llm-ui-adapter/src/shell/RemoteConversationEditor';
import {createNativeChatBinding, createNativeChatView} from '../../llm-ui-adapter/src/independent/native';

const disposals: Array<() => unknown> = [];
beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    Object.defineProperties(Range.prototype, {getClientRects: {configurable: true, value: () => []}, getBoundingClientRect: {configurable: true, value: () => new DOMRect()}});
});
afterEach(async () => {for (const dispose of disposals.splice(0).reverse()) await dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    Reflect.deleteProperty(Range.prototype, 'getClientRects'); Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');});

async function content(text = '<script>full command output</script>') {
    const bytes = new TextEncoder().encode(text), sha256 = await sha256Hex(bytes);
    const output: ConversationCommandOutput = {commandId: 'native-command', truncated: true,
        ref: {version: 1, epoch: 'epoch', requestId: 'operation', mimeType: 'text/plain', bytes: bytes.length, sha256}};
    return {bytes, output, text};
}
async function fixture(text?: string) {
    const data = await content(text), load = vi.fn(async () => new Uint8Array(data.bytes).buffer);
    const view = new NativeCommandOutput({loadCommandOutput: load}); document.body.append(view.element); view.update(data.output);
    disposals.push(() => view.destroy());
    const click = (action: string) => view.element.querySelector<HTMLButtonElement>(`[data-command-output-action="${action}"]`)!.click();
    return {...data, view, load, click};
}
function snapshot(output: ConversationCommandOutput): ConversationSnapshot {
    return {sessionId: 'native', title: 'Native', messages: [{id: 'command:native-command', role: 'system', text: 'short preview', status: 'completed', commandOutput: output}],
        requests: [], canSend: true, canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false};
}
function controls(state: ConversationSnapshot, load: ConversationControls['loadCommandOutput']): ConversationControls {
    return {read: vi.fn(async () => state), snapshot: () => state, refresh: vi.fn(async () => state), loadCommandOutput: load,
        send: vi.fn(async () => state), interrupt: vi.fn(async () => state), respond: vi.fn(async () => state), reconcile: vi.fn(async () => state), close: vi.fn(async () => {})};
}
async function pagedFixture(text: string) {
    const data = await content(text), load = vi.fn(async () => new Uint8Array(data.bytes).buffer);
    const read = vi.fn(async (_id: string, options?: {offset?: number; limit?: number}) => {
        const offset = options?.offset ?? 0, end = Math.min(data.bytes.length, offset + (options?.limit ?? 65536));
        return {ref: data.output.ref!, offset, data: arrayBufferToBase64(data.bytes.slice(offset, end).buffer), nextOffset: end === data.bytes.length ? null : end};
    });
    const view = new NativeCommandOutput({readCommandOutput: read, loadCommandOutput: load}); document.body.append(view.element); view.update(data.output);
    disposals.push(() => view.destroy());
    return {...data, view, read, load, click: (action: string) => view.element.querySelector<HTMLButtonElement>(`[data-command-output-action="${action}"]`)!.click()};
}

it('loads complete verified content on demand and pages Unicode without injecting HTML or repeating reads on updates', async () => {
    const prefix = '<script>literal</script>', f = await fixture(prefix + 'a'.repeat(65535 - prefix.length) + '🧪END');
    expect(f.load).not.toHaveBeenCalled(); expect(f.view.element.textContent).toContain(t('harness.commandOutput.preview', {bytes: f.bytes.length}));
    f.click('view'); await vi.waitFor(() => expect(f.view.element.querySelector('pre')).not.toBeNull());
    const first = f.view.element.querySelector('pre')!.textContent!; expect(first.length).toBeLessThanOrEqual(65536);
    expect(f.view.element.querySelector('script')).toBeNull(); f.click('next');
    expect(first + f.view.element.querySelector('pre')!.textContent).toBe(f.text);
    f.view.update(structuredClone(f.output)); expect(f.load).toHaveBeenCalledOnce();
});

it('keeps read errors local and offers retry while refusing corrupt data and oversized downloads', async () => {
    const f = await fixture();
    f.load.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_STORAGE_BODY'), {code: 'EACCES'}));
    f.click('view'); await vi.waitFor(() => expect(f.view.element.textContent).toContain('EACCES'));
    expect(f.view.element.textContent).not.toContain('PRIVATE_STORAGE_BODY'); f.click('view');
    await vi.waitFor(() => expect(f.view.element.querySelector('pre')?.textContent).toBe(f.text));
    f.load.mockResolvedValueOnce(new Uint8Array(f.bytes.length).buffer); f.click('view');
    await vi.waitFor(() => expect(f.view.element.textContent).toContain('COMMAND_OUTPUT_INTEGRITY'));
    f.view.update({...f.output, ref: {...f.output.ref!, bytes: 8 * 1024 * 1024 + 1}}); f.click('download');
    await vi.waitFor(() => expect(f.view.element.textContent).toContain('COMMAND_OUTPUT_TOO_LARGE')); expect(f.load).toHaveBeenCalledTimes(3);
});

it('assembles byte pages across UTF-8 boundaries before verified bounded DOM presentation', async () => {
    const f = await pagedFixture('a'.repeat(65535) + '🧪' + 'tail'); f.click('view');
    await vi.waitFor(() => expect(f.view.element.querySelector('pre')).not.toBeNull());
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.read.mock.calls.every(([, range]) => range!.limit! <= 65536)).toBe(true);
    const first = f.view.element.querySelector('pre')!.textContent!; f.click('next');
    const text = first + f.view.element.querySelector('pre')!.textContent;
    expect(text).toBe(f.text); expect(text).not.toContain('\ufffd'); expect(f.load).not.toHaveBeenCalled();
});

it.each(['cancel', 'hidden', 'destroyed'])('stops subsequent byte requests when a page is pending and the output is %s', async action => {
    const f = await pagedFixture('🧪'.repeat(50000)); let release!: (value: Awaited<ReturnType<typeof f.read>>) => void;
    const real = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce((id, options) => new Promise(resolve => {release = resolve;})); f.click('view');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (action === 'cancel') f.click('cancel');
    if (action === 'hidden') f.view.setActive(false);
    if (action === 'destroyed') f.view.destroy();
    release(await real('native-command', {offset: 0, limit: 65536})); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.read).toHaveBeenCalledOnce(); expect(f.load).not.toHaveBeenCalled(); expect(f.view.element.querySelector('pre')).toBeNull();
});

it('rejects pages whose reference or cursor changes without exposing unverified text', async () => {
    const f = await pagedFixture('large output'.repeat(10000)), real = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (id, options) => ({...await real(id, options), ref: {...f.output.ref!, epoch: 'foreign'}}));
    f.click('view'); await vi.waitFor(() => expect(f.view.element.textContent).toContain('COMMAND_OUTPUT_RESPONSE_INVALID'));
    expect(f.view.element.querySelector('pre')).toBeNull(); expect(f.read).toHaveBeenCalledOnce();
});

it('cancels a pending page across real RPC without requesting remaining bytes or changing the next draft', async () => {
    const data = await content('🧪'.repeat(50000)), state = {...snapshot(data.output), draft: 'untouched draft'};
    let server!: RpcPeer, release!: (page: import('@itookit/ui-common').ConversationCommandOutputPage) => void;
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    const source = controls(state, vi.fn()), read = vi.fn(() => new Promise<import('@itookit/ui-common').ConversationCommandOutputPage>(resolve => {release = resolve;}));
    source.readCommandOutput = read;
    const peer = client.decode(await server.expose(source)) as ConversationControls, view = new NativeCommandOutput(peer);
    document.body.append(view.element); view.update(data.output);
    try {
        view.element.querySelector<HTMLButtonElement>('[data-command-output-action="view"]')!.click();
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        view.element.querySelector<HTMLButtonElement>('[data-command-output-action="cancel"]')!.click();
        release({ref: data.output.ref!, offset: 0, data: arrayBufferToBase64(data.bytes.slice(0, 65536).buffer), nextOffset: 65536});
        await client.whenIdle(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(read).toHaveBeenCalledOnce(); expect(source.loadCommandOutput).not.toHaveBeenCalled();
        expect(view.element.querySelector('pre')).toBeNull(); expect((await peer.read()).draft).toBe('untouched draft'); expect(source.send).not.toHaveBeenCalled();
    } finally {view.destroy(); await client.close(); await server.close();}
});

it.each(['cancel', 'hidden', 'destroyed', 'changed'])('does not expose late content or URLs after the output was %s', async action => {
    const f = await fixture(); let release!: (value: ArrayBuffer) => void;
    f.load.mockImplementationOnce(() => new Promise(resolve => {release = resolve;})); f.click('view');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (action === 'cancel') f.click('cancel');
    if (action === 'hidden') f.view.setActive(false);
    if (action === 'destroyed') f.view.destroy();
    if (action === 'changed') f.view.update({...f.output, commandId: 'different', ref: {...f.output.ref!, requestId: 'different'}});
    release(new Uint8Array(f.bytes).buffer); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.view.element.querySelector('pre')).toBeNull();
});

it('downloads verified bytes through an owned URL and revokes it when the view closes', async () => {
    const created = vi.fn((_blob: Blob) => 'blob:command-output'), revoked = vi.fn();
    vi.stubGlobal('URL', {createObjectURL: created, revokeObjectURL: revoked});
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}), f = await fixture();
    f.click('download'); await vi.waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(created).toHaveBeenCalledOnce(); expect(created.mock.calls[0][0]).toBeInstanceOf(Blob);
    f.view.destroy(); expect(revoked).toHaveBeenCalledWith('blob:command-output');
});

it('mounts the output in the default native history and a failed read leaves the next draft sendable', async () => {
    const data = await content(), load = vi.fn(async () => {throw Object.assign(new Error('private transport body'), {code: 'NATIVE_EPOCH_CHANGED'});});
    const state = snapshot(data.output), peer = controls(state, load), host = document.createElement('div'); document.body.append(host);
    const editor = new RemoteConversationEditor(host, peer, {}); await editor.init(host); disposals.push(() => editor.destroy());
    expect(load).not.toHaveBeenCalled(); const button = host.querySelector<HTMLButtonElement>('[data-command-output-action="view"]');
    expect(button).not.toBeNull(); button!.click(); await vi.waitFor(() => expect(host.textContent).toContain('NATIVE_EPOCH_CHANGED'));
    expect(host.textContent).not.toContain('private transport body'); await editor.sendText('Next input');
    expect(peer.send).toHaveBeenCalledWith('Next input'); expect(state.messages[0].status).toBe('completed');
});

it('mounts the same output renderer in the independent ChatView and keeps draft input after local read failure', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const data = await content(), peer = controls(snapshot(data.output), vi.fn(async () => {throw Object.assign(new Error('private'), {code: 'EACCES'});}));
    vi.mocked(peer.send).mockResolvedValue({...snapshot(data.output), submittedTurnId: 'next-turn'});
    const binding = await createNativeChatBinding({conversationId: 'conversation', controls: peer, operations: createOperationLedger(), reconcile: vi.fn()});
    const host = document.createElement('div'); document.body.append(host); const view = await createNativeChatView(host, binding);
    disposals.push(async () => {await view.destroy(); binding.dispose();}); view.setText('Preserve next draft');
    await vi.waitFor(() => expect(host.querySelector('[data-command-output-action="view"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('[data-command-output-action="view"]')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('EACCES')); expect(view.getDraft().text).toBe('Preserve next draft');
    await view.submit(); expect(peer.send).toHaveBeenCalledOnce(); expect(peer.reconcile).not.toHaveBeenCalled();
});

it.each(['default', 'independent'])('shows committed result-association errors and reconciles the original identity in the %s view', async kind => {
    const state: ConversationSnapshot = {...snapshot((await content()).output), canSend: false, messages: [],
        resultError: {operationId: 'original-operation', code: 'COMMAND_RESULT_ENVELOPE_INVALID'}};
    const peer = controls(state, undefined), host = document.createElement('div'); document.body.append(host);
    if (kind === 'default') {
        const editor = new RemoteConversationEditor(host, peer, {}); await editor.init(host); disposals.push(() => editor.destroy());
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === t('harness.reconcile'))!;
        expect(button.disabled).toBe(false); button.click();
    } else {
        const binding = await createNativeChatBinding({conversationId: 'conversation', controls: peer, operations: createOperationLedger(), reconcile: vi.fn()});
        const view = await createNativeChatView(host, binding); disposals.push(async () => {await view.destroy(); binding.dispose();});
        host.querySelector<HTMLButtonElement>('[data-reconcile-result="original-operation"]')!.click();
    }
    await vi.waitFor(() => expect(peer.reconcile).toHaveBeenCalledWith('original-operation'));
    expect(host.textContent).toContain('COMMAND_RESULT_ENVELOPE_INVALID'); expect(peer.send).not.toHaveBeenCalled();
});
