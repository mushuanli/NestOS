// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteConversationEditor } from '../../llm-ui-adapter/src/shell/RemoteConversationEditor';
import type { ConversationControls, ConversationSnapshot, EditorOptions } from '@itookit/ui-common';
import { LLMPrintService } from '@itookit/mdx-adapter';
import { t } from '@itookit/common';
import { HistoryView } from '../../llm-ui-adapter/src/components/HistoryView';
const state: ConversationSnapshot = {sessionId:'s',title:'remote',branchName:'main',messages:[{id:'1',role:'assistant',text:'<script>native</script>',turnId:'initial-turn'}],requests:[],canSend:true,canInterrupt:false,canRespond:false,pending:false,disconnected:false,gap:false};
function branchState(): ConversationSnapshot {
    return {...state, canFork: true, forkSupport: 'latest', messages: [
        {id: 'u1', role: 'user', text: 'Same prompt', turnId: 'turn-one'},
        {id: 'a1', role: 'assistant', text: 'First reply', turnId: 'turn-one'},
        {id: 'u2', role: 'user', text: 'Same prompt', turnId: 'turn-two'},
        {id: 'a2', role: 'assistant', text: 'Second reply', turnId: 'turn-two'},
    ]};
}
function setup(options: EditorOptions = {}) {
    const peer: ConversationControls = {read:vi.fn(async () => state),refresh:vi.fn(async () => state),send:vi.fn(async () => ({...state,canSend:false,canInterrupt:true})),interrupt:vi.fn(async () => state),respond:vi.fn(async () => state),reconcile:vi.fn(async () => state),close:vi.fn(async () => {})};
    const host=document.createElement('div');document.body.append(host);
    const editor=new RemoteConversationEditor(host,peer,{title:'Server · Project · Codex', ...options});return {editor,peer,host};
}
it.each([false, true])('passes attachment-only input unchanged to the native port (queued=%s)', async queued => {
    const {editor, peer, host} = setup();
    const capable = {...state, attachments: ['text' as const], ...(queued ? {canQueue: true} : {})};
    vi.mocked(peer.read).mockResolvedValue(capable);
    peer.send = vi.fn(async () => ({...capable, submittedTurnId: 'file-turn'}));
    if (queued) peer.enqueue = vi.fn(async (_text, _files, _selection, id) => ({...capable, instructionQueue: {
        revision: 1, paused: false, acceptedIds: [id!], items: [{id: id!, text: '', files: [{name: 'notes.txt'}], createdAt: 1, state: 'pending'}],
    }}));
    await editor.init(host);
    try {
        const file = new File(['\ufeffNotes'], 'notes.txt', {type: 'text/plain'});
        Object.defineProperty(file, 'arrayBuffer', {value: async () => new TextEncoder().encode('\ufeffNotes').buffer});
        await editor.sendText('', [file]);
        const files = [{kind: 'text', name: 'notes.txt', content: '\ufeffNotes'}];
        if (queued) {expect(peer.enqueue).toHaveBeenCalledWith('', files, undefined, expect.any(String)); expect(peer.send).not.toHaveBeenCalled();}
        else expect(peer.send).toHaveBeenCalledWith('', files);
    } finally {await editor.destroy();}
});

it('reconciles a query report without querying or settling the unrelated pending input', async () => {
    const {editor, peer, host} = setup();
    let current: ConversationSnapshot = {...state, canSend: false, pending: true, pendingQueryReports: ['query'],
        submission: {id: 'original-input', status: 'pending'}};
    peer.snapshot = () => current; vi.mocked(peer.read).mockImplementation(async () => current);
    peer.reconcileQuery = vi.fn(async () => {
        current = {...current, pendingQueryReports: [], queryReceipts: [{id: 'query', status: 'accepted'}]}; return current;
    });
    await editor.init(host);
    try {
        expect(host.textContent).toContain(t('harness.queryReportPending'));
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(t('harness.reconcile')))!;
        expect(button.disabled).toBe(false); button.click();
        await vi.waitFor(() => expect(peer.reconcileQuery).toHaveBeenCalledWith('query'));
        expect(peer.reconcile).not.toHaveBeenCalled(); expect(current.submission).toEqual({id: 'original-input', status: 'pending'});
    } finally {await editor.destroy();}
});
it('runs a read-only command while a send reply hangs without replacing the pending submission or newer input', async () => {
    const {editor, peer, host} = setup(); let changed!: () => void, finish!: (value: ConversationSnapshot) => void;
    const command = {name: 'session:status', description: 'State', kind: 'action' as const, execution: 'query' as const, revision: 'v1'};
    let current: ConversationSnapshot = {...state, supportsSlashCommands: true, slashCommands: [command], canQueryCommand: true};
    peer.snapshot = () => current; peer.subscribe = listener => {changed = listener; return () => {};};
    peer.commands = vi.fn(async () => [command]); vi.mocked(peer.read).mockImplementation(async () => current);
    vi.mocked(peer.send).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    peer.queryCommand = vi.fn(async (_name, _args, operationId) => {
        current = {...current, queryReceipts: [{id: operationId!, status: 'accepted'}],
            messages: [...current.messages, {id: `command:${operationId}`, role: 'system', text: 'Observed status'}]}; return current;
    });
    await editor.init(host); const send = vi.spyOn(editor, 'sendText');
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    const button = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    input.value = 'Original'; input.dispatchEvent(new Event('input')); button.click();
    await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
    const sending = send.mock.results[0].value;
    let newerInput = false;
    try {
        await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
        current = {...current, canSend: false, pending: true}; changed();
        input.value = '/session:status'; input.dispatchEvent(new Event('input'));
        await vi.waitFor(() => expect(button.disabled).toBe(false)); button.click();
        await vi.waitFor(() => expect(peer.queryCommand).toHaveBeenCalledOnce());
        await send.mock.results[1].value;
        expect(peer.queryCommand).toHaveBeenCalledOnce(); expect(peer.send).toHaveBeenCalledOnce();
        expect(host.textContent).toContain('Observed status'); expect(input.value).toBe('');
        input.value = 'Keep newer input'; input.dispatchEvent(new Event('input')); newerInput = true;
    } finally {finish(current); await sending.catch(() => {}); if (newerInput) expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('Keep newer input'); await editor.destroy();}
});
it('exposes a branch button under native prompts and preserves the draft when branching from the latest turn', async () => {
    const navigate = vi.fn(), {editor, peer, host} = setup({onConversationSession: navigate});
    const current = {...branchState(), draft: 'Unsent follow-up'};
    vi.mocked(peer.read).mockResolvedValue(current);
    peer.fork = vi.fn(async () => ({...current, sessionId: 'forked'}));
    await editor.init(host);
    try {
        const buttons = host.querySelectorAll<HTMLButtonElement>('[data-native-branch]');
        expect(buttons).toHaveLength(2); buttons[1].click(); buttons[1].click();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('forked'));
        expect(peer.fork).toHaveBeenCalledOnce(); expect(peer.send).not.toHaveBeenCalled();
        expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('Unsent follow-up');
    } finally {await editor.destroy();}
});
it('requires explicit confirmation before substituting the latest turn for an older prompt', async () => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn()});
    vi.mocked(peer.read).mockResolvedValue(branchState()); peer.fork = vi.fn(async () => branchState());
    await editor.init(host);
    try {
        const button = host.querySelector<HTMLButtonElement>('[data-native-branch]')!;
        button.click(); expect(document.body.textContent).toContain(t('branch.latestOnly'));
        expect(document.querySelector('.settings-modal-confirm')?.textContent).toBe(t('branch.create'));
        document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
        await vi.waitFor(() => expect(document.querySelector('.settings-modal-overlay')).toBeNull());
        expect(peer.fork).not.toHaveBeenCalled();
        button.click(); document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
        await vi.waitFor(() => expect(peer.fork).toHaveBeenCalledOnce());
    } finally {await editor.destroy();}
});

it('keeps a failed checkpoint branch visible after reopening while preserving the original conversation and draft', async () => {
    const navigate = vi.fn(), {editor, peer, host} = setup({onConversationSession: navigate});
    const code = 'HARNESS_CHECKPOINT_BOUNDARY_MISMATCH';
    vi.mocked(peer.read).mockResolvedValue({...branchState(), forkSupport: 'turn', draft: 'Keep my next input', forkFailure: {
        requestId: 'fork-request', sourceSessionId: 's', sessionId: 'unverified-branch', turnId: 'turn-one', verified: false, code,
    }});
    await editor.init(host);
    try {
        expect(host.textContent).toContain(t('branch.checkpointFailed', {code, id: 'unverified-branch'}));
        expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('Keep my next input');
        expect(navigate.mock.calls).toEqual([['s']]); expect(peer.send).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});
it('reports unsupported native branching and retains input without dispatching a prompt', async () => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn()});
    vi.mocked(peer.read).mockResolvedValue({...branchState(), forkSupport: 'none', canFork: false, draft: 'Keep me'});
    await editor.init(host);
    try {
        host.querySelector<HTMLButtonElement>('[data-native-branch]')!.click();
        await vi.waitFor(() => expect(document.querySelector('.settings-toast--error')?.textContent).toContain(t('branch.unsupported')));
        expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('Keep me'); expect(peer.send).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});
it('passes exact native turn and message IDs to a host that supports historical branching', async () => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn()});
    vi.mocked(peer.read).mockResolvedValue({...branchState(), forkSupport: 'turn'});
    peer.forkAt = vi.fn(async () => branchState()); peer.fork = vi.fn(async () => branchState());
    await editor.init(host);
    try {
        host.querySelector<HTMLButtonElement>('[data-native-branch]')!.click();
        await vi.waitFor(() => expect(peer.forkAt).toHaveBeenCalledExactlyOnceWith({messageId: 'u1', turnId: 'turn-one'}));
        expect(peer.fork).not.toHaveBeenCalled(); expect(document.querySelector('.settings-modal-overlay')).toBeNull();
    } finally {await editor.destroy();}
});
it('dismisses an unconfirmed branch substitution when the view is hidden', async () => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn()});
    vi.mocked(peer.read).mockResolvedValue(branchState()); peer.fork = vi.fn(async () => branchState());
    await editor.init(host);
    try {
        host.querySelector<HTMLButtonElement>('[data-native-branch]')!.click(); editor.cancelPendingRender();
        document.querySelector<HTMLButtonElement>('.settings-modal-confirm')?.click();
        await vi.waitFor(() => expect(document.querySelector('.settings-modal-overlay')).toBeNull());
        expect(peer.fork).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});
it('routes native /branch through host branching and keeps the branch switcher reachable in the mobile menu', async () => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn(), mountCompactNavigation: slot => {slot.textContent = 'Mobile navigation'; return () => {};}});
    vi.mocked(peer.read).mockResolvedValue({...branchState(), draft: '/branch Review'});
    peer.fork = vi.fn(async () => branchState()); peer.command = vi.fn(async () => branchState());
    await editor.init(host);
    try {
        expect(host.querySelector('.llm-workspace-titlebar__menu #llm-branch-indicator')).not.toBeNull();
        await editor.commands.sendMessage({text: '/branch Review'});
        expect(peer.fork).toHaveBeenCalledExactlyOnceWith('Review');
        expect(peer.command).not.toHaveBeenCalled(); expect(peer.send).not.toHaveBeenCalled();
        expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('');
    } finally {await editor.destroy();}
});
it('keeps a rejected branch command visible and never falls back to sending it as a prompt', async () => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn()});
    vi.mocked(peer.read).mockResolvedValue({...branchState(), forkSupport: 'none', canFork: false, draft: '/branch Review'});
    await editor.init(host);
    try {
        await expect(editor.commands.sendMessage({text: '/branch Review'})).rejects.toThrow();
        expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('/branch Review');
        expect(peer.send).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});
it.each(['hidden', 'reactivated', 'readOnly', 'destroyed'] as const)('invalidates a queued native branch when the editor is %s during draft saving', async lifecycle => {
    const {editor, peer, host} = setup({onConversationSession: vi.fn()});
    const current = {...branchState(), draft: '/branch Review'};
    vi.mocked(peer.read).mockResolvedValue(current); peer.fork = vi.fn(async () => current);
    await editor.init(host);
    let release!: () => void;
    const saving = new Promise<void>(resolve => {release = resolve;});
    const flush = vi.spyOn(editor, 'flushPendingSave').mockReturnValueOnce(saving);
    let dispose: Promise<void> | undefined, activate: Promise<void> | undefined;
    try {
        const pending = editor.commands.sendMessage({text: '/branch Review'});
        const rejected = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(flush).toHaveBeenCalled());
        if (lifecycle === 'readOnly') editor.setReadOnly(true);
        else if (lifecycle === 'destroyed') dispose = editor.destroy();
        else {editor.cancelPendingRender(); if (lifecycle === 'reactivated') activate = editor.activate();}
        release(); await rejected; await activate; await dispose;
        expect(peer.fork).not.toHaveBeenCalled(); expect(peer.send).not.toHaveBeenCalled();
        if (lifecycle !== 'destroyed') expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('/branch Review');
    } finally {release(); await editor.destroy();}
});
it('renders growing long answers during a pending send and reads the latest answer on manual refresh and reopen', async () => {
    vi.stubGlobal('Worker', class {
        onmessage?: (event: unknown) => void;
        terminate() {}
        postMessage({text}: {text: string}) {
            queueMicrotask(() => this.onmessage?.({data: {tokens: [{type: 'paragraph', raw: text, text, tokens: [{type: 'text', raw: text, text}]}]}}));
        }
    });
    const {editor, peer, host} = setup(); let changed!: () => void, finish!: (value: ConversationSnapshot) => void;
    let current = {...state, messages: [{id: 'long', role: 'assistant' as const, text: 'Long response. '.repeat(8192), turnId: 'long-turn'}]};
    peer.snapshot = () => current; peer.subscribe = listener => {changed = listener; return () => {};};
    vi.mocked(peer.read).mockImplementation(async () => current);
    vi.mocked(peer.send).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    await editor.init(host); const sending = editor.commands.sendMessage({text: 'Continue'});
    try {
        await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
        current = {...current, messages: [{...current.messages[0], text: current.messages[0].text + ' streamed-tail-marker'}]}; changed();
        await vi.waitFor(() => expect(host.textContent).toContain('streamed-tail-marker'));
        finish(current); await sending;
        current = {...current, messages: [{...current.messages[0], text: current.messages[0].text + ' refreshed-tail-marker'}]};
        host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
        await vi.waitFor(() => expect(host.textContent).toContain('refreshed-tail-marker'));
    } finally {finish?.(current); await sending.catch(() => {}); await editor.destroy();}
    const reopened = new RemoteConversationEditor(host, peer, {});
    try {await reopened.init(host); expect(host.textContent).toContain('refreshed-tail-marker');}
    finally {await reopened.destroy();}
});
it('shows and answers an interaction while the send response is still pending', async () => {
    const {editor, peer, host} = setup(); let changed!: () => void, finish!: (value: ConversationSnapshot) => void;
    let current = state;
    peer.snapshot = () => current; peer.subscribe = listener => {changed = listener; return () => {};};
    vi.mocked(peer.send).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    vi.mocked(peer.respond).mockImplementation(async () => {current = {...state, canSend: false, canInterrupt: true}; finish(current); return current;});
    await editor.init(host);
    const sending = editor.commands.sendMessage({text: 'Please execute'});
    try {
        await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
        current = {...state, canSend: false, canRespond: true, pending: true, requests: [{id: 'early', kind: 'approval', detail: 'Early approval'}]}; changed();
        await vi.waitFor(() => expect(host.querySelector('.remote-conversation__interactions button')).not.toBeNull());
        const approve = host.querySelector<HTMLButtonElement>('.remote-conversation__interactions button')!;
        expect(approve.disabled).toBe(false); approve.click(); await sending;
        expect(peer.respond).toHaveBeenCalledWith('early', {decision: 'accept'});
    } finally {finish?.(state); await sending.catch(() => {}); await editor.destroy();}
});
beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches:false,addEventListener() {},removeEventListener() {}}));
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: vi.fn()});
    Object.defineProperties(Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new DOMRect()}});
});
afterEach(() => {document.body.replaceChildren();vi.useRealTimers();vi.unstubAllGlobals();delete (Range.prototype as any).getClientRects;delete (Range.prototype as any).getBoundingClientRect;delete (HTMLElement.prototype as any).scrollIntoView;});

it('selects native models and exposes reasoning options for the selected model only', async () => {
    const {editor, peer, host} = setup();
    peer.models = vi.fn(async () => ({models: [
        {id: 'reasoning', label: 'Reasoning model', reasoningEfforts: [{id: 'high', label: 'High effort'}]},
        {id: 'plain', label: 'Plain model', reasoningEfforts: []},
    ]}));
    vi.mocked(peer.read).mockResolvedValue({...state, supportsModels: true});
    vi.mocked(peer.refresh).mockResolvedValue({...state, supportsModels: true});
    vi.mocked(peer.send).mockResolvedValue({...state, supportsModels: true});
    await editor.init(host);
    const trigger = host.querySelector<HTMLButtonElement>('.llm-input__native-model')!;
    const choose = async (label: string) => {
        trigger.click();
        await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent ?? '', label).toContain(label));
        const item = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible [data-index]')].find(row => row.textContent?.includes(label));
        expect(item).toBeDefined(); item!.click();
    };
    try {
        expect(trigger.hidden).toBe(false);
        await choose('Reasoning model'); await choose('High effort');
        await editor.commands.sendMessage({text: 'Prompt'});
        expect(peer.send).toHaveBeenCalledWith('Prompt', [], {modelId: 'reasoning', reasoningEffort: 'high'});
        await choose('Plain model'); trigger.click();
        await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('Plain model'));
        expect(document.querySelector('.llm-popup--visible')?.textContent).not.toContain('High effort');
    } finally {await editor.destroy();}
});

it.each(['destroyed', 'hidden'])('discards model discovery results after the native input is %s', async mode => {
    const {editor, peer, host} = setup();
    let finish!: (catalog: import('@itookit/ui-common').ConversationModelCatalog) => void;
    peer.models = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    vi.mocked(peer.read).mockResolvedValue({...state, supportsModels: true});
    vi.mocked(peer.refresh).mockResolvedValue({...state, supportsModels: true});
    vi.mocked(peer.send).mockResolvedValue({...state, supportsModels: true});
    await editor.init(host); host.querySelector<HTMLButtonElement>('.llm-input__native-model')!.click();
    if (mode === 'hidden') editor.cancelPendingRender(); else await editor.destroy();
    finish({models: [{id: 'late', label: 'Late model', reasoningEfforts: []}]});
    await Promise.resolve(); expect(document.querySelector('.llm-popup--visible')).toBeNull(); await editor.destroy();
});

it('captures model selection for native prompt commands and keeps action commands independent', async () => {
    const {editor, peer, host} = setup();
    peer.commands = vi.fn(async () => [{name: 'team:verify', description: 'Verify', kind: 'prompt'}, {name: 'compact', description: 'Compact', kind: 'action'}]);
    peer.command = vi.fn(async () => ({...state, supportsSlashCommands: true, draft: ''}));
    vi.mocked(peer.read).mockResolvedValue({...state, supportsSlashCommands: true});
    await editor.init(host);
    try {
        const nativeSelection = {modelId: 'native', reasoningEffort: 'high'};
        await editor.commands.sendMessage({text: '/team:verify', nativeSelection});
        expect(peer.command).toHaveBeenLastCalledWith('team:verify', '', nativeSelection, '/team:verify');
        await editor.commands.sendMessage({text: '/compact', nativeSelection});
        expect(peer.command).toHaveBeenLastCalledWith('compact', '', undefined, '/compact');
        expect(peer.send).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});

it('suggests only the current harness commands and dispatches commands through its control port', async () => {
    const {editor, peer, host} = setup();
    peer.commands = vi.fn(async () => [{name: 'compact', description: 'Native compact', kind: 'action'}]);
    peer.command = vi.fn(async () => ({...state, supportsSlashCommands: true, draft: ''}));
    vi.mocked(peer.read).mockResolvedValue({...state, supportsSlashCommands: true});
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        input.value = '/com'; input.dispatchEvent(new Event('input', {bubbles: true}));
        await vi.waitFor(() => expect(document.querySelector('.llm-popup--slash')?.textContent).toContain('/compact'));
        expect(document.querySelector('.llm-popup--slash')?.textContent).not.toContain('/exec');
        await editor.commands.sendMessage({text: '/compact'});
        expect(peer.command).toHaveBeenCalledWith('compact', '', undefined, '/compact'); expect(peer.send).not.toHaveBeenCalled();
        await expect(editor.commands.sendMessage({text: '/exec secret'})).rejects.toThrow();
        expect(peer.command).toHaveBeenCalledOnce();
    } finally {await editor.destroy();}
});

it.each(['closed', 'hidden'])('does not restore native command suggestions after the input is %s', async mode => {
    const {editor, peer, host} = setup();
    let finish!: (rows: import('@itookit/ui-common').ConversationSlashCommand[]) => void;
    peer.commands = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    await editor.init(host);
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    input.value = '/'; input.dispatchEvent(new Event('input', {bubbles: true}));
    if (mode === 'closed') await editor.destroy(); else editor.cancelPendingRender();
    finish([{name: 'compact', description: 'Native', kind: 'action'}]);
    await Promise.resolve();
    expect(document.querySelector('.llm-popup--visible.llm-popup--slash')).toBeNull();
    await editor.destroy();
});

it('coalesces candidate discovery across keystrokes and revalidates the raw command on send', async () => {
    const {editor, peer, host} = setup();
    let finish!: (rows: import('@itookit/ui-common').ConversationSlashCommand[]) => void;
    peer.commands = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    peer.command = vi.fn(async () => ({...state, supportsSlashCommands: true, draft: ''}));
    vi.mocked(peer.read).mockResolvedValue({...state, supportsSlashCommands: true});
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        for (const text of ['/', '/c', '/com']) {input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));}
        expect(peer.commands).toHaveBeenCalledOnce();
        const commands = [{name: 'compact', description: 'Compact', kind: 'action' as const}];
        finish(commands); await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('/compact'));
        vi.mocked(peer.commands).mockResolvedValue(commands);
        input.value = '/compact '; input.dispatchEvent(new Event('input', {bubbles: true}));
        host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
        await vi.waitFor(() => expect(peer.command).toHaveBeenCalledWith('compact', '', undefined, '/compact '));
        expect(peer.commands).toHaveBeenCalledTimes(2);
    } finally {await editor.destroy();}
});

it('preserves a command draft edited back to identical text while acceptance is pending', async () => {
    const {editor, peer, host} = setup();
    peer.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    let finish!: (snapshot: ConversationSnapshot) => void;
    peer.command = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    vi.mocked(peer.read).mockResolvedValue({...state, supportsSlashCommands: true});
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        const edit = (text: string) => {input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));};
        edit('/compact '); const sending = editor.commands.sendMessage({text: '/compact'});
        await vi.waitFor(() => expect(peer.command).toHaveBeenCalledOnce());
        edit('New draft'); edit('/compact '); finish({...state, supportsSlashCommands: true, draft: ''});
        await sending; expect(input.value).toBe('/compact ');
    } finally {await editor.destroy();}
});
it.each(['missing', 'throwing'])('submits native conversations when randomUUID is %s', async mode => {
    const {editor, host, peer} = setup(); await editor.init(host);
    const native = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: native.getRandomValues.bind(native),
        randomUUID: mode === 'missing' ? undefined : () => {throw new Error('Insecure context');}});
    try {await editor.commands.sendMessage({text: 'HTTP compatible'}); expect(peer.send).toHaveBeenCalledWith('HTTP compatible');}
    finally {await editor.destroy();}
});
it.each([['codex', 'Codex'], ['dsht', 'DSHT'], ['claudecode', 'Claude Code']])('shows %s beside the editable conversation name', async (kind, label) => {
    const {editor, host} = setup({conversationSource: {kind}}); await editor.init(host);
    try {
        expect(host.querySelector(`[data-conversation-source="${kind}"]`)?.textContent).toContain(label);
        expect(host.querySelector<HTMLInputElement>('#llm-title-input')?.value).toBe('remote');
    } finally {await editor.destroy();}
});
it('mounts host actions in the same More menu and releases them when the native editor closes', async () => {
    const cleanup = vi.fn(), mountMoreMenu = vi.fn((container: HTMLElement) => {
        const button = document.createElement('button'); button.textContent = 'Host action'; container.append(button);
        return () => { button.remove(); cleanup(); };
    });
    const {editor, host} = setup({mountMoreMenu}); await editor.init(host);
    expect(mountMoreMenu).toHaveBeenCalledOnce();
    expect(host.querySelector('.llm-workspace-titlebar__menu')?.textContent).toContain('Host action');
    await editor.destroy(); expect(cleanup).toHaveBeenCalledOnce();
});
it('keeps passive native diagnostics in More while preserving live updates and input drafts', async () => {
    const prototype = HTMLDialogElement.prototype;
    const descriptors = ['showModal', 'close'].map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)] as const);
    Object.defineProperties(prototype, {
        showModal: {configurable: true, value(this: HTMLDialogElement) {this.open = true;}},
        close: {configurable: true, value(this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event('close'));}},
    });
    const {editor, peer, host} = setup(); let changed!: () => void;
    let snapshot: ConversationSnapshot = {...state, observation: {execution: 'unknown', rawStatus: 'notLoaded',
        source: 'history', observedAt: Date.now(), connection: 'online', stale: false, receiptUnknown: false},
        createdAt: 1000, updatedAt: 2000,
        usage: {scope: 'transcript', complete: true, observedAt: Date.now(),
            totals: {inputTokens: 130454600, outputTokens: 29, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0}},
        usageEstimate: {currency: 'USD', estimatedCostUsd: 15.833715, complete: true}};
    vi.mocked(peer.read).mockImplementation(async () => snapshot);
    peer.snapshot = () => snapshot; peer.subscribe = listener => {changed = listener; return () => {};};
    try {
        await editor.init(host);
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!; input.value = 'Keep my draft';
        const indicator = host.querySelector<HTMLElement>('#llm-status-indicator')!;
        expect(indicator.hidden).toBe(true); expect(host.querySelector('.remote-conversation__status')?.textContent).toBe('');
        expect(host.textContent).not.toContain('130,454,629');
        const menu = host.querySelector<HTMLDetailsElement>('.llm-workspace-titlebar__menu')!; menu.open = true;
        const openInfo = () => host.querySelector<HTMLButtonElement>('[data-action="conversation-information"]')!.click();
        openInfo(); const dialog = document.querySelector<HTMLDialogElement>('.remote-conversation-info')!;
        expect(dialog.open).toBe(true); expect(menu.open).toBe(false);
        expect([...dialog.querySelectorAll('dt')].map(item => item.textContent)).toEqual([t('project.createdAt'), t('project.lastActivity')]);
        const time = (field: string) => dialog.querySelector<HTMLTimeElement>(`[data-session-time="${field}"]`)!;
        expect(time('createdAt').dateTime).toBe(new Date(1000).toISOString());
        expect(time('updatedAt').dateTime).toBe(new Date(2000).toISOString());
        expect(dialog.textContent).toContain(t('harness.unloadedHelp'));
        expect(dialog.textContent).toContain(t('harness.usageHelp')); expect(dialog.textContent).toContain('130,454,629');
        expect(dialog.textContent).toContain('15.83'); expect(dialog.textContent).not.toContain('15.833715');
        snapshot = {...snapshot, updatedAt: 4000, observation: {...snapshot.observation!, execution: 'running'}}; changed();
        await vi.waitFor(() => expect(dialog.querySelector('[data-session-info-status]')?.textContent).toContain(t('harness.state.running')));
        expect(document.querySelector('.remote-conversation-info')).toBe(dialog); expect(indicator.hidden).toBe(false);
        expect(time('createdAt').dateTime).toBe(new Date(1000).toISOString());
        expect(time('updatedAt').dateTime).toBe(new Date(4000).toISOString());
        expect(input.value).toBe('Keep my draft');
        snapshot = {...snapshot, createdAt: null, updatedAt: null, disconnected: true,
            observation: {...snapshot.observation!, connection: 'offline'}}; changed();
        await vi.waitFor(() => expect(host.querySelector('.remote-conversation__status')?.textContent).toContain(t('harness.state.offline')));
        expect(time('createdAt').textContent).toBe(t('project.timeUnknown')); expect(time('createdAt').hasAttribute('datetime')).toBe(false);
        expect(time('updatedAt').textContent).toBe(t('project.timeUnknown')); expect(time('updatedAt').hasAttribute('title')).toBe(false);
        dialog.querySelector<HTMLButtonElement>('button')!.click(); expect(dialog.isConnected).toBe(false);
        menu.open = true; openInfo(); expect(document.querySelector('.remote-conversation-info')).not.toBeNull();
        expect(peer.send).not.toHaveBeenCalled(); expect(peer.interrupt).not.toHaveBeenCalled();
    } finally {
        await editor.destroy();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(prototype, name, descriptor); else Reflect.deleteProperty(prototype, name);
        }
    }
    expect(document.querySelector('.remote-conversation-info')).toBeNull();
});
it('loads an earlier native page and locates the actual message from a search hit', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true});
    peer.loadEarlier = vi.fn(async () => ({...state, hasEarlier: false, messages: [{id: 'old-item', role: 'user', text: 'Earlier search hit', turnId: 'old-turn'}, ...state.messages]}));
    await editor.init(host);
    await editor.navigateTo({elementId: 'native-item:old-item'});
    expect(peer.loadEarlier).toHaveBeenCalledOnce();
    expect(host.querySelector('.llm-ui-search-hit')?.textContent).toContain('Earlier search hit');
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    await editor.destroy();
});
it('renders native history safely and sends directly through the injected conversation port', async () => {
    const {editor,peer,host}=setup(); await editor.init(host);
    expect(host.querySelector('script')).toBeNull();expect(host.textContent).toContain('<script>native</script>');
    await editor.commands.sendMessage({text:'remote prompt'});expect(peer.send).toHaveBeenCalledWith('remote prompt');
    await editor.destroy();expect(peer.close).toHaveBeenCalledOnce();expect(peer.interrupt).not.toHaveBeenCalled();
});

it('navigates collapsed native prompts and loads earlier directory entries on request', async () => {
    const {editor, peer, host} = setup();
    const prompt = {id: 'prompt', role: 'user' as const, turnId: 'turn', text: 'Visible prompt', contentParts: ['Private context', 'Visible prompt'], contentPartKinds: ['agents_md.instructions', 'user.text']};
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true, messages: [prompt, ...state.messages]});
    peer.loadEarlier = vi.fn(async () => ({...state, hasEarlier: false, messages: [{id: 'older', role: 'user', text: 'Older prompt', turnId: 'older-turn'}, prompt, ...state.messages]}));
    await editor.init(host);
    const history = host.querySelector<HTMLElement>('#llm-ui-history')!; history.scrollTo = vi.fn();
    expect(host.querySelector('#llm-btn-history-visibility')).toBeNull();
    host.querySelector<HTMLButtonElement>('#llm-btn-collapse')!.click(); expect(history.hidden).toBe(false);
    host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    const row = host.querySelector<HTMLButtonElement>('[data-prompt-id]')!;
    expect(row.textContent).toContain('Visible prompt'); expect(row.textContent).not.toContain('Private context');
    expect(peer.loadEarlier).not.toHaveBeenCalled(); row.click(); expect(history.hidden).toBe(false);
    expect(host.querySelector('.llm-ui-bubble--user')?.classList.contains('is-collapsed')).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>('.llm-ui-transcript-context')!.open).toBe(false);
    host.querySelector<HTMLButtonElement>('[data-action="earlier"]')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-prompt-id]')).toHaveLength(2));
    expect(peer.loadEarlier).toHaveBeenCalledOnce(); expect(host.querySelector('.llm-prompt-nav__list')?.textContent).toContain('Older prompt');
    await editor.destroy(); expect(host.querySelector('.llm-prompt-nav')).toBeNull();
});

it('finds user prompts on opening the directory when the latest native page contains only responses', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true});
    peer.loadEarlier = vi.fn().mockResolvedValueOnce({...state, hasEarlier: true, messages: [{id: 'tool', role: 'tool', text: 'Tool output'}, ...state.messages]})
        .mockResolvedValueOnce({...state, hasEarlier: true, messages: [{id: 'p', role: 'user', text: 'The latest user prompt'}, ...state.messages]});
    await editor.init(host); expect(peer.loadEarlier).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-prompt-id]')?.textContent).toContain('The latest user prompt'));
    expect(peer.loadEarlier).toHaveBeenCalledTimes(2);
    await editor.destroy();
});

it('bounds prompt discovery and retains its manual retry when an earlier page fails', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true});
    peer.loadEarlier = vi.fn().mockRejectedValueOnce(new Error('Directory history unavailable'));
    await editor.init(host); host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    await vi.waitFor(() => expect(host.querySelector('.llm-prompt-nav__scope')?.textContent).toContain('Directory history unavailable'));
    host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click(); host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    expect(peer.loadEarlier).toHaveBeenCalledOnce();
    vi.mocked(peer.loadEarlier).mockResolvedValue({...state, hasEarlier: false, messages: [{id: 'p', role: 'user', text: 'Recovered prompt'}]});
    host.querySelector<HTMLButtonElement>('[data-action="earlier"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-prompt-id]')?.textContent).toContain('Recovered prompt'));
    await editor.destroy();
});

it('stops an explicit directory search after three pages when no user prompt has been found', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true});
    peer.subscribe = () => () => {};
    peer.loadEarlier = vi.fn(async () => ({...state, hasEarlier: true}));
    await editor.init(host); host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    await vi.waitFor(() => expect(host.querySelector('.llm-prompt-nav__empty')?.textContent).toBe(t('chat.promptNav.noLoadedPrompts')));
    expect(peer.loadEarlier).toHaveBeenCalledTimes(3);
    expect(host.querySelector<HTMLButtonElement>('[data-action="earlier"]')!.disabled).toBe(false);
    await editor.destroy();
});

it('reports a subscribed render failure without claiming disconnection and preserves the input draft', async () => {
    let changed!: () => void;
    const {editor, peer, host} = setup();
    peer.subscribe = listener => { changed = listener; return () => {}; };
    peer.snapshot = () => state;
    await editor.init(host);
    const draft = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    draft.value = 'keep my draft';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const render = vi.spyOn(HistoryView.prototype, 'renderSnapshot').mockRejectedValueOnce(new Error('render failed'));
    try {
        changed();
        await vi.waitFor(() => expect(host.querySelector('.remote-conversation__status')?.textContent)
            .toBe(t('harness.updateFailed', {message: 'render failed'})));
        expect(host.textContent).not.toContain(t('harness.disconnected')); expect(draft.value).toBe('keep my draft');
        expect(errors).toHaveBeenCalledWith('[Conversation] Update failed', expect.any(Error));
        changed();
        await vi.waitFor(() => expect(host.querySelector('.remote-conversation__status')?.textContent).not.toContain('render failed'));
    } finally { render.mockRestore(); await editor.destroy(); errors.mockRestore(); }
});

it('reports event-triggered update errors and recovers without replaying sends', async () => {
    const {editor, peer, host} = setup(); let changed!: () => void;
    peer.subscribe = listener => {changed = listener; return () => {};};
    await editor.init(host);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(peer.refresh).mockRejectedValueOnce(new Error('invalid snapshot'));
    try {
        changed();
        await vi.waitFor(() => expect(host.querySelector('.remote-conversation__status')?.textContent)
            .toBe(t('harness.updateFailed', {message: 'invalid snapshot'})), {timeout: 2500});
        changed(); await vi.waitFor(() => expect(host.querySelector('.remote-conversation__status')?.textContent).not.toContain('invalid snapshot'), {timeout: 2500});
        expect(peer.send).not.toHaveBeenCalled(); expect(host.textContent).not.toContain(t('harness.disconnected'));
    } finally { await editor.destroy(); errors.mockRestore(); }
});
it('does not poll or re-read an idle displayed conversation', async () => {
    const {editor, peer, host} = setup(); await editor.init(host);
    try {await new Promise(resolve => setTimeout(resolve, 1200)); expect(peer.read).toHaveBeenCalledOnce(); expect(peer.refresh).not.toHaveBeenCalled();}
    finally {await editor.destroy();}
});
it('preserves failed input and offers reconciliation instead of repeating an unknown operation', async () => {
    const {editor,peer,host}=setup();await editor.init(host);
    vi.mocked(peer.send).mockRejectedValue({outcome:'unknown'});vi.mocked(peer.read).mockResolvedValue({...state,pending:true,canSend:false});
    host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value='keep draft';await expect(editor.sendText('keep draft')).rejects.toBeDefined();
    expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('keep draft');
    expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
    await expect(editor.sendText('keep draft')).rejects.toThrow();expect(peer.send).toHaveBeenCalledOnce();await editor.destroy();
});
it('accepts a committed turn even when a following metadata operation needs reconciliation', async () => {
    const {editor, peer, host} = setup(); await editor.init(host);
    vi.mocked(peer.send).mockResolvedValue({...state, submittedTurnId: 'accepted', pending: true, canSend: false});
    host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value = 'Accepted input';
    await expect(editor.sendText('Accepted input')).resolves.toBeUndefined();
    expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('');
    expect(host.textContent).not.toContain(t('chat.submission.unknown'));
    expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
    expect(peer.send).toHaveBeenCalledOnce(); await editor.destroy();
});
it('renders pending approvals but prevents responding without native control ownership', async () => {
    const {editor,peer,host}=setup();vi.mocked(peer.read).mockResolvedValue({...state,requests:[{id:1,kind:'approval',detail:'command'}]});await editor.init(host);
    const approve=[...host.querySelectorAll('button')].find(b=>b.textContent===t('harness.approve'))!;expect(approve.disabled).toBe(true);
    approve.click();expect(peer.respond).not.toHaveBeenCalled();await editor.destroy();
});

it('saves an unsent remote input draft before closing the retained editor',async () => {
    const {editor,peer,host}=setup();peer.saveDraft=vi.fn(async () => {});
    vi.mocked(peer.read).mockResolvedValue({...state,draft:'restored input'});await editor.init(host);
    expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('restored input');
    host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value='changed input';const changed=vi.fn();editor.on('interactiveChange',changed);
    host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.dispatchEvent(new Event('input'));expect(changed).toHaveBeenCalledOnce();
    await editor.destroy();expect(peer.saveDraft).toHaveBeenCalledWith('changed input');expect(peer.send).not.toHaveBeenCalled();
});

it('saves native input before switching execution targets and leaves the native turn untouched', async () => {
    const start = vi.fn(async () => {}), {editor, peer, host} = setup({onStartConversationDraft: start});
    peer.saveDraft = vi.fn(async () => {}); await editor.init(host);
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    input.value = 'Another executor'; input.dispatchEvent(new Event('input'));
    host.querySelector<HTMLButtonElement>('.llm-input__btn--switch-target')!.click();
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith({text: 'Another executor', files: []}));
    expect(peer.saveDraft).toHaveBeenCalledWith('Another executor');
    expect(vi.mocked(peer.saveDraft).mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(peer.send).not.toHaveBeenCalled(); expect(peer.interrupt).not.toHaveBeenCalled(); await editor.destroy();
});

it('cancels an obsolete history load when the host replaces the view',async () => {
    const {peer,host}=setup(),lifetime=new AbortController();let reject!: (reason:unknown)=>void;
    vi.mocked(peer.read).mockImplementationOnce(() => new Promise((_resolve,fail) => {reject=fail;}));
    vi.mocked(peer.close).mockImplementation(async () => {reject(new Error('closed'));});
    const editor=new RemoteConversationEditor(host,peer,{signal:lifetime.signal});const opening=editor.init(host);
    lifetime.abort();await expect(opening).rejects.toBeDefined();expect(peer.close).toHaveBeenCalledOnce();await editor.destroy();
});

it('renders each user and assistant message in its own MDx editor and preserves editors during refresh',async()=>{
    const {editor,peer,host}=setup();
    const messages=[{id:'u',role:'user' as const,text:'**User question**'},{id:'a',role:'assistant' as const,text:'## Assistant reply\n\n```html\n<script>sample</script>\n```'}];
    vi.mocked(peer.read).mockResolvedValue({...state,messages});await editor.init(host);
    expect(host.querySelectorAll('.llm-ui-session .mdx-editor-renderer')).toHaveLength(2);
    expect(host.querySelector('[data-role="user"].llm-ui-session')).not.toBeNull();
    expect(host.querySelector('[data-role="user"] .mdx-editor-renderer strong')?.textContent).toBe('User question');
    expect(host.querySelector('[data-role="assistant"] .mdx-editor-renderer h2')?.textContent).toBe('Assistant reply');
    expect(host.querySelector('[data-role="assistant"] .mdx-editor-renderer pre code')?.textContent).toContain('<script>sample</script>');
    const original=host.querySelector('[data-role="assistant"] .mdx-editor-renderer');
    vi.mocked(peer.read).mockResolvedValue({...state,messages:[messages[0],{...messages[1],text:'## Updated reply'}]});
    host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
    await vi.waitFor(()=>expect(original?.textContent).toContain('Updated reply'));
    expect(host.querySelector('[data-role="assistant"] .mdx-editor-renderer')).toBe(original);await editor.destroy();
});
it('enables native branch creation and announces the new remote identity for host navigation',async()=>{
    const {peer,host}=setup();peer.fork=vi.fn(async()=>({...state,sessionId:'forked',canFork:false}));
    peer.branches=vi.fn(async()=>[{id:'s',title:'Original'},{id:'sibling',title:'Alternative'}]);
    vi.mocked(peer.read).mockResolvedValue({...state,canFork:true});const navigate=vi.fn();
    const editor=new RemoteConversationEditor(host,peer,{onConversationSession:navigate});await editor.init(host);
    host.querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
    await vi.waitFor(() => expect(host.querySelector('.remote-conversation__branch-create')).not.toBeNull());
    const name=host.querySelector<HTMLInputElement>('input[aria-label="' + t('harness.branchName') + '"]')!;name.value='Review';
    const create=[...host.querySelectorAll('button')].find(b=>b.textContent===t('harness.createBranch'))!;
    expect(create.disabled).toBe(false);create.click();await vi.waitFor(()=>expect(navigate).toHaveBeenCalledWith('forked'));
    expect(peer.fork).toHaveBeenCalledExactlyOnceWith('Review');expect(create.disabled).toBe(true);await editor.destroy();
});
it('shows the remote error details and allows history loading to be retried',async()=>{
    const {editor,peer,host}=setup();vi.mocked(peer.read).mockRejectedValueOnce(new Error('Native path unavailable'));
    await editor.init(host);expect(host.querySelector('.remote-conversation__status')?.textContent).toContain('Native path unavailable');
    expect(host.querySelector('.llm-workspace-status__dot')?.classList.contains('--failed')).toBe(true);
    host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
    await vi.waitFor(()=>expect(host.querySelector('.mdx-editor-renderer')).not.toBeNull());await editor.destroy();
});

it('uses the shared workspace, history actions and ChatInput while respecting native capabilities', async () => {
    const {editor, peer, host} = setup(); await editor.init(host);
    expect(host.classList.contains('llm-ui-workspace')).toBe(true);
    expect(host.querySelector('.llm-workspace-titlebar')).not.toBeNull();
    expect(host.querySelector('.llm-input__textarea')).not.toBeNull();
    expect(host.querySelector('.llm-ui-session--assistant [data-action="copy"]')).not.toBeNull();
    expect(host.querySelector('.llm-ui-session--assistant [data-action="collapse"]')).not.toBeNull();
    expect(host.querySelector('.llm-ui-session [data-action="edit"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--attach')!.hidden).toBe(true);
    const send = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    input.value = 'native message'; input.dispatchEvent(new Event('input')); send.click();
    await vi.waitFor(() => expect(peer.send).toHaveBeenCalledExactlyOnceWith('native message'));
    await vi.waitFor(() => expect(send.disabled).toBe(true));
    expect(input.value).toBe('');
    await editor.destroy();
});

it('shares titlebar sidebar, history and responsive menu actions for a read-only native conversation', async () => {
    const toggleSidebar = vi.fn();
    const {editor, host} = setup({readOnly: true, hostContext: {toggleSidebar, navigate: async () => {}}});
    await editor.init(host);
    const toggle = host.querySelector<HTMLButtonElement>('#llm-btn-sidebar')!;
    expect(toggle.hidden).toBe(false); toggle.click(); expect(toggleSidebar).toHaveBeenCalledOnce();
    expect(host.querySelector('.llm-workspace-status__dot')?.classList.contains('--idle')).toBe(true);
    const menu = host.querySelector<HTMLDetailsElement>('.llm-workspace-titlebar__menu')!; menu.open = true;
    expect(host.querySelector('#llm-btn-history-visibility')).toBeNull();
    const collapse = host.querySelector<HTMLButtonElement>('#llm-btn-collapse')!;
    collapse.click(); expect(menu.open).toBe(false); expect(host.querySelector<HTMLElement>('#llm-ui-history')!.hidden).toBe(false);
    expect(collapse.getAttribute('aria-label')).toBe(t('chat.toolbar.expandAll'));
    collapse.click(); expect(collapse.getAttribute('aria-label')).toBe(t('chat.toolbar.collapseAll'));
    expect(host.querySelector('#llm-btn-prompt-nav')?.textContent?.trim()).toBe('');
    expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
    await editor.destroy(); toggle.click(); expect(toggleSidebar).toHaveBeenCalledOnce();
});

it('uses the shared navigator and print service with native history instead of local Session commands', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, messages: [{id: 'u', role: 'user', text: 'Question'}, {id: 'a', role: 'assistant', text: 'Answer\n\n<script>literal</script>'}]});
    const print = vi.spyOn(LLMPrintService.prototype, 'printFromHtml').mockResolvedValue(undefined);
    try {
        await editor.init(host);
        for (const id of ['llm-btn-prev-unfolded', 'llm-btn-next-unfolded', 'llm-btn-print', 'llm-btn-navigator']) expect(host.querySelector<HTMLButtonElement>('#' + id)!.hidden).toBe(false);
        host.querySelector<HTMLButtonElement>('#llm-btn-navigator')!.click();
        expect(host.querySelectorAll('.llm-nav-item')).toHaveLength(2);
        expect(host.querySelector('.llm-nav-panel [data-action="batch-delete"]')).toBeNull();
        expect(host.querySelector('.llm-nav-panel [data-action="toggle-context"]')).toBeNull();
        expect(host.querySelector('.llm-nav-panel [data-action="create-branch"]')).toBeNull();
        host.querySelector<HTMLElement>('.llm-nav-item__content')!.click();
        expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({block: 'start', behavior: 'smooth'});
        host.querySelector<HTMLButtonElement>('#llm-btn-print')!.click();
        await vi.waitFor(() => expect(print).toHaveBeenCalledWith(expect.stringContaining('Question'), {title: 'remote', showHeader: true}));
        const printed = document.createElement('div'); printed.innerHTML = print.mock.calls[0][0];
        expect(printed.textContent).toContain('Answer'); expect(printed.textContent).toContain('<script>literal</script>'); expect(printed.querySelector('script')).toBeNull();
    } finally { await editor.destroy(); print.mockRestore(); }
});

it('selects native branch identities through the shared dropdown even when titles match', async () => {
    const navigate = vi.fn(), {editor, peer, host} = setup({onConversationSession: navigate});
    peer.branches = vi.fn(async () => [{id: 's', title: 'Request preview', branchName: 'Same <title>'}, {id: 'other', title: 'Other preview', branchName: 'Same <title>', parentSessionId: 's'}]);
    await editor.init(host); host.querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.llm-branch-dropdown__item')).toHaveLength(2));
    expect(host.querySelector('.llm-branch-indicator-count')?.textContent).toBe('2');
    expect(host.querySelector('.llm-branch-dropdown__delete')).toBeNull();
    expect(host.querySelector('.llm-branch-dropdown title')).toBeNull();
    expect(host.querySelector('.llm-branch-indicator-name')?.textContent).toBe('Same <title>');
    expect(host.querySelector('.llm-branch-dropdown')?.textContent).not.toContain('Request preview');
    host.querySelector<HTMLElement>('[data-branch-name="other"]')!.click(); expect(navigate).toHaveBeenCalledWith('other');
    expect(host.querySelector<HTMLElement>('.llm-branch-dropdown')!.style.display).toBe('none'); await editor.destroy();
});

it('navigates the shared unfolded history controls and skips folded native responses', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, messages: [
        {id: 'u1', turnId: 't1', role: 'user', text: 'First'}, {id: 'a1', turnId: 't1', role: 'assistant', text: 'First reply'},
        {id: 'u2', turnId: 't2', role: 'user', text: 'Second'}, {id: 'a2', turnId: 't2', role: 'assistant', text: 'Second reply'},
    ]}); await editor.init(host);
    vi.spyOn(host.querySelector<HTMLElement>('#llm-ui-history')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 300));
    const groups = [...host.querySelectorAll<HTMLElement>('.llm-ui-session')];
    for (const [index, top] of [-100, 110, 450, 550].entries()) vi.spyOn(groups[index], 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 600, 60));
    host.querySelector<HTMLButtonElement>('#llm-btn-prev-unfolded')!.click();
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(groups[0]);
    groups[3].querySelector<HTMLButtonElement>('[data-action="collapse"]')!.click();
    host.querySelector<HTMLButtonElement>('#llm-btn-next-unfolded')!.click();
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(groups[2]);
    vi.spyOn(groups[3], 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -60, 600, 60));
    host.querySelector<HTMLButtonElement>('#llm-btn-prev-unfolded')!.click();
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(groups[0]);
    await editor.destroy();
});

it('keeps the shared input locked against repeated sends after an unknown native outcome', async () => {
    const {editor, peer, host} = setup(); await editor.init(host);
    vi.mocked(peer.send).mockRejectedValueOnce({outcome: 'unknown'});
    vi.mocked(peer.read).mockResolvedValue({...state, pending: true, canSend: false});
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    const send = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    input.value = 'keep native input'; input.dispatchEvent(new Event('input')); send.click();
    await vi.waitFor(() => expect(host.querySelector('.remote-conversation__status')?.textContent).toContain(t('chat.submission.unknown')));
    expect(send.disabled).toBe(true); expect(input.value).toBe('keep native input');
    send.click(); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(peer.send).toHaveBeenCalledOnce(); await editor.destroy();
});
it('prepends native history using shared cards without losing existing Markdown editor identity', async () => {
    const {editor, peer, host} = setup(); let resolve!: (snapshot: ConversationSnapshot) => void;
    peer.loadEarlier = vi.fn(() => new Promise<ConversationSnapshot>(done => {resolve = done;}));
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true}); await editor.init(host);
    const original = host.querySelector('[data-role="assistant"] .mdx-editor-renderer');
    expect(host.querySelector<HTMLElement>('.remote-conversation__history-progress')!.hidden).toBe(false);
    expect(host.querySelector('.remote-conversation__history-progress')?.textContent).toContain(t('harness.partialHistory', {count: 1}));
    expect(peer.loadEarlier).not.toHaveBeenCalled();
    [...host.querySelectorAll('button')].find(button => button.textContent === t('harness.earlierHistory'))!.click();
    await vi.waitFor(() => expect(peer.loadEarlier).toHaveBeenCalledOnce());
    expect(host.querySelector('.remote-conversation__history-progress')?.textContent).toContain(t('harness.loadingEarlier', {count: 1}));
    resolve({...state, messages: [{id: 'older-"/><img onerror="bad">', role: 'user', text: 'Earlier **question**', turnId: 'older-turn'}, ...state.messages], hasEarlier: false});
    await vi.waitFor(() => expect(host.querySelectorAll('.llm-ui-session')).toHaveLength(2));
    expect(host.querySelector('[data-role="assistant"] .mdx-editor-renderer')).toBe(original);
    expect(host.querySelector('#llm-ui-history')?.textContent).toContain('Earlier question');
    expect(host.querySelector('img[onerror]')).toBeNull(); await editor.destroy();
});
it('loads one earlier history page per request and stops at the beginning', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true});
    const middle = {id: 'middle', role: 'user' as const, text: 'Middle request', turnId: 'middle-turn'};
    peer.loadEarlier = vi.fn().mockResolvedValueOnce({...state, messages: [middle, ...state.messages], hasEarlier: true})
        .mockResolvedValueOnce({...state, messages: [{...middle, id: 'first', turnId: 'first-turn', text: 'First request'}, middle, ...state.messages], hasEarlier: false});
    await editor.init(host); expect(peer.loadEarlier).not.toHaveBeenCalled();
    const earlier = () => [...host.querySelectorAll('button')].find(button => button.textContent === t('harness.earlierHistory'))!;
    earlier().click(); await vi.waitFor(() => expect(host.textContent).toContain('Middle request'));
    expect(peer.loadEarlier).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect((earlier() as HTMLButtonElement).disabled).toBe(false)); earlier().click();
    await vi.waitFor(() => expect(host.querySelector('#llm-ui-history')?.textContent).toContain('First request'));
    expect(peer.loadEarlier).toHaveBeenCalledTimes(2);
    expect(host.querySelector<HTMLElement>('.remote-conversation__history-progress')!.hidden).toBe(true); await editor.destroy();
});
it('keeps a history paging failure visible through polls and retries only when requested', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true});
    vi.mocked(peer.refresh).mockResolvedValue({...state, hasEarlier: true});
    peer.loadEarlier = vi.fn().mockRejectedValueOnce(new Error('Conversation history capacity reached'))
        .mockResolvedValueOnce({...state, hasEarlier: false});
    await editor.init(host);
    expect(peer.loadEarlier).not.toHaveBeenCalled();
    [...host.querySelectorAll('button')].find(button => button.textContent === t('harness.earlierHistory'))!.click();
    await vi.waitFor(() => expect(host.querySelector('.remote-conversation__history-progress')?.textContent).toContain('capacity reached'));
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(peer.loadEarlier).toHaveBeenCalledOnce(); expect(host.textContent).toContain('capacity reached');
    [...host.querySelectorAll('button')].find(button => button.textContent === t('harness.earlierHistory'))!.click();
    await vi.waitFor(() => expect(peer.loadEarlier).toHaveBeenCalledTimes(2)); await editor.destroy();
});
it('shows first command lines and file targets without rendering full tool arguments or output', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, createdAt: 1791458500000, updatedAt: 1791458565000, messages: [
        {id: 'tool', role: 'tool', text: 'exec', name: 'exec', commandPreview: 'pnpm typecheck', paths: ['/project/src/main.ts'], operation: 'execute', turnId: 'initial-turn'},
        ...state.messages]});
    await editor.init(host);
    const output = host.querySelector('[data-role="assistant"] .mdx-editor-renderer')!;
    expect(output.textContent).toContain('pnpm typecheck'); expect(output.textContent).toContain('/project/src/main.ts');
    expect(output.querySelectorAll('code').length).toBeGreaterThan(0);
    expect(host.querySelector<HTMLInputElement>('#llm-title-input')!.title).toContain(t('workbench.created'));
    expect(host.querySelector<HTMLInputElement>('#llm-title-input')!.title).toContain(t('workbench.modified')); await editor.destroy();
});

it('retains follow-up input typed while the native send is waiting for acknowledgement', async () => {
    const {editor, peer, host} = setup(); await editor.init(host);
    let acknowledge!: (snapshot: ConversationSnapshot) => void;
    vi.mocked(peer.send).mockImplementationOnce(() => new Promise(resolve => {acknowledge = resolve;}));
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    input.value = 'first message'; input.dispatchEvent(new Event('input'));
    host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click();
    await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
    input.value = 'next draft'; input.dispatchEvent(new Event('input'));
    acknowledge({...state, canSend: false, canInterrupt: true});
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--stop')!.disabled).toBe(false));
    expect(input.value).toBe('next draft'); expect(editor.isDirty()).toBe(true);
    expect(host.querySelector('.llm-workspace-status__text')?.textContent).toBe(t('harness.running'));
    expect(host.querySelector('.llm-workspace-status__dot')?.classList.contains('--running')).toBe(true);
    peer.saveDraft = vi.fn(async () => {}); await editor.destroy(); expect(peer.saveDraft).toHaveBeenCalledWith('next draft');
});
it('uses local receipt observations when native history cannot be read after an uncertain operation', async () => {
    const {editor, peer, host} = setup(); await editor.init(host);
    peer.snapshot = vi.fn(() => ({...state, pending: true, canSend: false, canInterrupt: false, canRespond: false}));
    vi.mocked(peer.send).mockRejectedValueOnce({outcome: 'unknown'});
    vi.mocked(peer.read).mockRejectedValue(new Error('Network unavailable'));
    await expect(editor.sendText('uncertain')).rejects.toBeDefined();
    expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
    expect(host.querySelector('.remote-conversation__status')?.textContent).toContain(t('chat.submission.unknown'));
    expect([...host.querySelectorAll('button')].find(button => button.textContent === t('harness.reconcile'))!.disabled).toBe(false);
    expect(host.querySelector('.llm-workspace-status__dot')?.classList.contains('--queued')).toBe(true);
    await expect(editor.sendText('uncertain')).rejects.toThrow(); expect(peer.send).toHaveBeenCalledOnce(); await editor.destroy();
});

it('groups all native response items with compact tool targets and keeps assistant code collapsible', async () => {
    const {editor, peer, host} = setup();
    const messages: ConversationSnapshot['messages'] = [
        {id: 'u1', turnId: 't1', role: 'user', text: 'Find **references**'},
        {id: 'a1', turnId: 't1', role: 'assistant', text: 'I will inspect the files.'},
        {id: 'cmd1', turnId: 't1', role: 'tool', name: 'Bash', paths: ['file.ts'], operation: 'search', input: 'rg references .', inputLanguage: 'bash', text: 'private tool output\n<script>sample</script>'},
        {id: 'a2', turnId: 't1', role: 'assistant', text: '## Result\n\nFound the references.\n\n```ts\nconst result = true;\n```'},
        {id: 'u2', turnId: 't2', role: 'user', text: 'Review the result'},
        {id: 'a3', turnId: 't2', role: 'assistant', text: '## Review'},
    ];
    vi.mocked(peer.read).mockResolvedValue({...state, messages}); await editor.init(host);
    expect(host.querySelectorAll('.llm-ui-session .mdx-editor-renderer')).toHaveLength(4);
    expect(host.querySelectorAll('.llm-ui-session--assistant .mdx-editor-renderer')).toHaveLength(2);
    const reply = host.querySelector<HTMLElement>('.llm-ui-session--assistant .mdx-editor-renderer')!;
    expect(reply.textContent).toContain('I will inspect'); expect(reply.textContent).toContain('Found the references');
    expect(reply.querySelectorAll('pre code')).toHaveLength(1);
    expect(reply.querySelector('pre code')?.textContent).toContain('const result');
    expect(editor.getText()).toContain('file.ts'); expect(editor.getText()).toContain(t('harness.toolOperation.search'));
    expect(editor.getText()).not.toContain('rg references .'); expect(editor.getText()).not.toContain('private tool output');
    expect(reply.querySelector('script')).toBeNull();
    const folded = reply.querySelector<HTMLElement>('[data-has-collapse="true"]')!;
    const toggle = folded.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true'); toggle.click(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    vi.mocked(peer.read).mockResolvedValue({...state, messages: messages.map(message => message.id === 'a2' ? {...message, text: '## Updated result'} : message)});
    host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
    await vi.waitFor(() => expect(reply.textContent).toContain('Updated result'));
    expect(host.querySelector('.llm-ui-session--assistant .mdx-editor-renderer')).toBe(reply); await editor.destroy();
});

it('separates system notes and tool provenance from answer headings and preserves expanded notes during refresh', async () => {
    const { editor, peer, host } = setup();
    const messages: ConversationSnapshot['messages'] = [
        { id: 'u', turnId: 't', role: 'user', text: 'Review this project' },
        { id: 's', turnId: 't', role: 'system', text: 'Session resumed\n<script>literal</script>\n```\nkeep fences' },
        { id: 'a', turnId: 't', role: 'assistant', text: 'First answer' },
        { id: 'tool', turnId: 't', role: 'tool', name: 'Read <file>', operation: 'read', paths: ['src/<sample>.ts'], text: 'private output' },
        { id: 'final', turnId: 't', role: 'assistant', text: 'Final answer' },
    ];
    vi.mocked(peer.read).mockResolvedValue({ ...state, messages }); await editor.init(host);
    const output = host.querySelector<HTMLElement>('.llm-ui-session--assistant .mdx-editor-renderer')!;
    const note = output.querySelector<HTMLDetailsElement>('.llm-ui-transcript-note')!;
    expect(note.open).toBe(false); expect(note.querySelector('summary')?.textContent).toContain(t('chatMessage.systemNote'));
    expect(note.querySelector('.llm-ui-transcript-note__content')?.textContent).toBe(messages[1].text);
    expect(output.querySelector('script')).toBeNull(); expect(output.querySelector('h3')).toBeNull();
    expect(output.querySelector('.llm-ui-transcript-tool__label')?.textContent).toContain(t('harness.roleTool'));
    expect(output.querySelector('.llm-ui-transcript-tool__name')?.textContent).toContain('Read <file>');
    expect(output.querySelector('.llm-ui-transcript-tool__targets')?.textContent).toContain('src/<sample>.ts');
    expect(output.textContent).not.toContain('private output');
    note.querySelector('summary')!.click(); expect(note.open).toBe(true);
    note.dispatchEvent(new Event('toggle'));
    vi.mocked(peer.read).mockResolvedValue({ ...state, messages: messages.map(message => message.id === 'final' ? { ...message, text: 'Updated final answer' } : message) });
    host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
    await vi.waitFor(() => expect(output.textContent).toContain('Updated final answer'));
    expect(output.querySelector<HTMLDetailsElement>('.llm-ui-transcript-note')!.open).toBe(true);
    expect(host.querySelector('.llm-ui-session--assistant .mdx-editor-renderer')).toBe(output);
    expect(editor.getText()).toContain('Session resumed'); await editor.destroy();
});
it('keeps native turn grouping independent of interleaved events and merges optimistic user echoes', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, messages: [
        {id: 'submitted:t1', turnId: 't1', role: 'user', text: 'One request'},
        {id: 'u1', turnId: 't1', role: 'user', text: 'One request'},
        {id: 'u2', turnId: 't2', role: 'user', text: 'Two request'},
        {id: 'a1', turnId: 't1', role: 'assistant', text: 'Answer one'},
        {id: 'a2', turnId: 't2', role: 'assistant', text: 'Answer two'},
    ]}); await editor.init(host);
    const groups = [...host.querySelectorAll<HTMLElement>('.llm-ui-session')]; expect(groups).toHaveLength(4);
    expect(groups[0].querySelector('.mdx-editor-renderer')?.textContent?.trim()).toBe('One request');
    expect(groups[1].textContent).toContain('Answer one'); expect(groups[2].textContent).toContain('Two request'); expect(groups[3].textContent).toContain('Answer two');
    await editor.destroy();
});

it('shows all requests and responses in a turn, preserves repeated native requests and displays actual timestamps', async () => {
    const {editor, peer, host} = setup(); peer.branches = vi.fn(async () => []);
    const at = Date.parse('2026-10-08T11:22:45Z');
    vi.mocked(peer.read).mockResolvedValue({...state, title: 'Long request preview', branchName: 'review', messages: [
        {id: 'u1', turnId: 't1', role: 'user', text: 'Request one\nRequest two', contentParts: ['Request one', 'Request two'], timestamp: at},
        {id: 'u2', turnId: 't1', role: 'user', text: 'Repeat', timestamp: at + 1},
        {id: 'u3', turnId: 't1', role: 'user', text: 'Repeat', timestamp: at + 2},
        {id: 'a1', turnId: 't1', role: 'assistant', text: 'Answer one', timestamp: at + 1000},
        {id: 'tool', turnId: 't1', role: 'tool', name: 'apply_patch', paths: ['src/main.ts'], operation: 'write', text: 'private diff'},
        {id: 'a2', turnId: 't1', role: 'assistant', text: 'Answer two', timestamp: at + 2000},
        {id: 'a3', turnId: 't1', role: 'assistant', text: 'Answer three', timestamp: at + 3000},
    ]}); await editor.init(host);
    expect(host.querySelectorAll('.llm-ui-session .mdx-editor-renderer')).toHaveLength(2);
    const request = host.querySelector('.llm-ui-session--user .mdx-editor-renderer')!.textContent!;
    expect(request).toContain('Request one'); expect(request).toContain('Request two'); expect(request.match(/Repeat/g)).toHaveLength(2);
    expect(host.querySelectorAll('.llm-ui-session--user .mdx-editor-renderer hr')).toHaveLength(3);
    expect(host.querySelector('.llm-ui-session--user .mdx-editor-renderer h2')).toBeNull();
    expect(editor.getText()).toContain('Request one\n\n---\n\nRequest two\n\n---\n\nRepeat\n\n---\n\nRepeat');
    const response = host.querySelector('.llm-ui-session--assistant .mdx-editor-renderer')!.textContent!;
    for (const text of ['Answer one', 'Answer two', 'Answer three', 'apply_patch', 'src/main.ts']) expect(response).toContain(text);
    expect(response).not.toContain('private diff');
    expect(host.querySelector('.llm-branch-indicator-name')?.textContent).toBe('review');
    expect(host.querySelector('.llm-ui-session')!.textContent).toContain(new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
    await editor.destroy();
});

it('collapses only explicitly sourced context and keeps original references copyable across refreshes and printing', async () => {
    const {editor, peer, host} = setup();
    const rules = '# AGENTS.md instructions for /project\n\n<script>literal</script>\n```ts\nconst keep = true;\n```';
    const environment = '<environment_context>\n  <cwd>/project</cwd>\n</environment_context>';
    const messages: ConversationSnapshot['messages'] = [
        {id: 'context', turnId: 't', role: 'user', text: rules, contentParts: [rules], contentPartKinds: ['agents_md.instructions']},
        {id: 'environment', turnId: 't', role: 'user', text: environment, contentParts: [environment], contentPartKinds: ['environments.environment_context']},
        {id: 'prompt', turnId: 't', role: 'user', text: '**Review this project**\nPreserve this request too',
            contentParts: ['**Review this project**', 'Preserve this request too'], contentPartKinds: ['user.text', 'user.text']},
        {id: 'unknown', turnId: 't', role: 'user', text: 'Unknown context stays visible', contentParts: ['Unknown context stays visible'], contentPartKinds: ['unknown']},
        {id: 'literal', turnId: 't', role: 'user', text: '# AGENTS.md instructions for /real-user-message'},
        {id: 'answer', turnId: 't', role: 'assistant', text: 'Initial answer'},
    ];
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    const print = vi.spyOn(LLMPrintService.prototype, 'printFromHtml').mockResolvedValue(undefined);
    try {
        vi.mocked(peer.read).mockResolvedValue({...state, messages}); await editor.init(host);
        const request = host.querySelector<HTMLElement>('.llm-ui-session--user .mdx-editor-renderer')!;
        const contexts = request.querySelectorAll<HTMLDetailsElement>('.llm-ui-transcript-context');
        expect(contexts).toHaveLength(2); expect([...contexts].every(context => !context.open)).toBe(true);
        expect(request.querySelectorAll('hr')).toHaveLength(3);
        for (const context of contexts) {
            expect(context.previousElementSibling?.tagName).not.toBe('HR');
            expect(context.nextElementSibling?.tagName).not.toBe('HR');
        }
        expect(contexts[0].querySelector('summary')?.textContent).toContain(t('chatMessage.contextInstructions'));
        expect(contexts[0].querySelector('.llm-ui-transcript-context__content')?.textContent).toBe(rules);
        expect(request.querySelector('script')).toBeNull(); expect(request.querySelector('strong')?.textContent).toBe('Review this project');
        expect(request.querySelector('h1')?.textContent).toContain('/real-user-message');
        expect(request.textContent).toContain('Unknown context stays visible');
        contexts[0].querySelector('summary')!.click(); contexts[0].dispatchEvent(new Event('toggle'));
        contexts[0].querySelector<HTMLButtonElement>('[data-transcript-copy]')!.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(rules));
        vi.mocked(peer.read).mockResolvedValue({...state, messages: [...messages, {id: 'followup', turnId: 't', role: 'user', text: 'Follow-up'}]});
        host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
        await vi.waitFor(() => expect(request.textContent).toContain('Follow-up'));
        expect(request.querySelector<HTMLDetailsElement>('.llm-ui-transcript-context')!.open).toBe(true);
        host.querySelector<HTMLButtonElement>('#llm-btn-print')!.click();
        await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
        const printed = document.createElement('div'); printed.innerHTML = print.mock.calls[0][0];
        expect(printed.querySelector('.llm-ui-transcript-context__content')?.textContent).toBe(rules);
        expect(printed.querySelector('script')).toBeNull(); expect(editor.getText()).toContain(environment);
    } finally { await editor.destroy(); print.mockRestore(); delete (navigator as any).clipboard; }
});

it('enables native title editing only when the injected port grants rename', async () => {
    const {editor, peer, host} = setup();
    peer.rename = vi.fn(async title => ({...state, title, canRename: true}));
    vi.mocked(peer.read).mockResolvedValue({...state, canRename: true}); await editor.init(host);
    const title = host.querySelector<HTMLInputElement>('#llm-title-input')!;
    expect(title.readOnly).toBe(false); title.value = 'Changed native title'; title.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(peer.rename).toHaveBeenCalledExactlyOnceWith('Changed native title'));
    [...host.querySelectorAll<HTMLButtonElement>('.llm-workspace-titlebar__menu-actions button')]
        .find(button => button.textContent === t('project.renameSession'))!.click();
    document.querySelector<HTMLInputElement>('.settings-modal input')!.value = 'Changed through More';
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(peer.rename).toHaveBeenLastCalledWith('Changed through More'));
    await editor.destroy();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-overlay')).toBeNull());
});
it('sends bounded inline attachments through the native conversation port and rejects binary data before sending', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, attachments: ['text', 'image']}); await editor.init(host);
    const bytes = new TextEncoder().encode('quoted "text"\n中文');
    const file = {name: 'notes.md', type: 'text/markdown', size: bytes.length, arrayBuffer: async () => bytes.buffer} as File;
    await editor.commands.sendMessage({text: 'Review', files: [file]});
    expect(peer.send).toHaveBeenCalledWith('Review', [{kind: 'text', name: 'notes.md', content: 'quoted "text"\n中文'}]);
    const binary = {...file, arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer};
    await expect(editor.commands.sendMessage({text: 'Preserve draft', files: [binary]})).rejects.toThrow();
    expect(peer.send).toHaveBeenCalledOnce(); await editor.destroy();
});

it('restores attachment drafts and preserves newer edits when an unknown turn is confirmed', async () => {
    const {editor, peer, host} = setup();
    peer.snapshot = vi.fn(() => ({...state, attachments: ['text']})); peer.saveDraft = vi.fn(async () => {});
    const attachment = {kind: 'text' as const, name: 'notes.md', content: 'Unsent native notes'};
    vi.mocked(peer.read).mockResolvedValue({...state, pending: true, canSend: false, attachments: ['text'], draft: 'Submitted input', draftAttachments: [attachment]});
    await editor.init(host); expect(host.textContent).toContain('notes.md'); expect(editor.isDirty()).toBe(false);
    const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    input.value = 'Newer edit'; input.dispatchEvent(new Event('input'));
    peer.reconcile = vi.fn(async () => ({...state, draft: '', draftAttachments: [], attachments: ['text']}));
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t('harness.reconcile'))!.click();
    await vi.waitFor(() => expect(peer.reconcile).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(host.textContent).not.toContain('notes.md'));
    expect(input.value).toBe('Newer edit'); await editor.destroy(); expect(peer.saveDraft).toHaveBeenCalledWith('Newer edit');
    expect(peer.send).not.toHaveBeenCalled();
});

it('shows the shared user bubble while submission is pending and replaces it by the exact native turn', async () => {
    const {editor, peer, host} = setup(); let accept!: (value: ConversationSnapshot) => void;
    vi.mocked(peer.send).mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    await editor.init(host);
    const sending = editor.sendText('immediate feedback');
    await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
    const provisional = host.querySelector('.llm-ui-session--user')!;
    expect(provisional.textContent).toContain('immediate feedback');
    expect(provisional.querySelector('.llm-ui-bubble .llm-ui-submission-status')?.textContent).toBe(t('chat.submission.submitting'));
    accept({...state, submittedTurnId: 'confirmed', messages: [...state.messages,
        {id: 'native-user', turnId: 'confirmed', role: 'user', text: 'immediate feedback'}]});
    await sending;
    expect(host.querySelectorAll('.llm-ui-session--user')).toHaveLength(1);
    expect(host.querySelector('.llm-ui-submission-status')).toBeNull();
    await editor.destroy();
});

it('keeps the paging entry inside the history pane and suppresses inferred activity in the conversation', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.read).mockResolvedValue({...state, hasEarlier: true, observation: {execution: 'unknown', updatedAt: Date.now(),
        source: 'history', observedAt: Date.now(), connection: 'online', stale: false, receiptUnknown: false}});
    peer.loadEarlier = vi.fn(async () => ({...state, hasEarlier: false}));
    await editor.init(host);
    const history = host.querySelector('#llm-ui-history')!;
    expect(history.firstElementChild?.classList.contains('remote-conversation__history-progress')).toBe(true);
    expect(host.querySelector('.llm-ui-workspace__workbench')?.children).toHaveLength(1);
    expect(peer.loadEarlier).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(t('harness.activity.recent'));
    host.querySelector<HTMLButtonElement>('.remote-conversation__earlier')!.click();
    await vi.waitFor(() => expect(peer.loadEarlier).toHaveBeenCalledOnce());
    await editor.destroy();
});

it('keeps an occupied-session failure visible across refreshes without submitting another message', async () => {
    const {editor, peer, host} = setup();
    vi.mocked(peer.send).mockRejectedValue(Object.assign(new Error('HARNESS_SESSION_BUSY'), {remoteCode: 'HARNESS_SESSION_BUSY', outcome: 'not-committed'}));
    await editor.init(host);
    await expect(editor.sendText('retained')).rejects.toThrow('HARNESS_SESSION_BUSY');
    expect(host.querySelector('.llm-ui-bubble .llm-ui-submission-status')?.textContent).toContain(t('chat.submission.occupied'));
    host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
    await vi.waitFor(() => expect(peer.read).toHaveBeenCalledTimes(3));
    expect(host.querySelector('.llm-ui-submission-status')?.textContent).toContain(t('chat.submission.occupied'));
    expect(peer.send).toHaveBeenCalledOnce(); await editor.destroy();
});

it('deletes a non-current native branch through the host without navigating to it', async () => {
    const remove = vi.fn(async () => {}), navigate = vi.fn();
    const {editor, peer, host} = setup({removeConversationSession: remove, onConversationSession: navigate});
    peer.branches = vi.fn(async () => [{id: 's', title: 'Current'}, {id: 'other', title: 'Other'}]);
    await editor.init(host); navigate.mockClear();
    host.querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.llm-branch-dropdown__item')).toHaveLength(2));
    expect(host.querySelector('.is-current .llm-branch-dropdown__delete')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-branch-name="other"] .llm-branch-dropdown__delete')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    (document.querySelector('.settings-modal-confirm') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('other'));
    expect(navigate).not.toHaveBeenCalled(); await editor.destroy();
});

it('releases a hidden conversation subscription and reads its latest state when activated again', async () => {
    const {editor, peer, host} = setup(); let notify!: () => void;
    const release = vi.fn(); peer.subscribe = vi.fn(listener => {notify = listener; return release;});
    await editor.init(host); expect(peer.subscribe).toHaveBeenCalledOnce();
    editor.cancelPendingRender(); notify(); await new Promise(resolve => setTimeout(resolve, 80));
    expect(release).toHaveBeenCalledOnce(); expect(peer.refresh).not.toHaveBeenCalled();
    vi.mocked(peer.read).mockResolvedValue({...state, messages: [...state.messages, {id: 'latest', role: 'assistant', text: 'Received while hidden'}]});
    await editor.activate(); expect(peer.read).toHaveBeenCalledTimes(2); expect(peer.subscribe).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Received while hidden'); await editor.destroy();
});

it('keeps authored transcript-like code as ordinary code in history and print', async () => {
    const {editor, peer, host} = setup();
    const raw = ['mindos-context authored agents_md.instructions', 'mindos-system authored', 'mindos-tool']
        .map(language => '```' + language + '\nOrdinary authored example\n```').join('\n\n');
    vi.mocked(peer.read).mockResolvedValue({...state, messages: [
        {id: 'prompt', turnId: 'turn', role: 'user', text: raw},
        {id: 'reply', turnId: 'turn', role: 'assistant', text: raw},
    ]});
    const print = vi.spyOn(LLMPrintService.prototype, 'printFromHtml').mockResolvedValue(undefined);
    try {
        await editor.init(host);
        expect(host.querySelectorAll('.llm-ui-transcript-context, .llm-ui-transcript-note, .llm-ui-transcript-tool')).toHaveLength(0);
        expect(host.querySelectorAll('.llm-ui-session pre')).toHaveLength(6);
        host.querySelector<HTMLButtonElement>('#llm-btn-print')!.click();
        await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
        const printed = document.createElement('div'); printed.innerHTML = print.mock.calls[0][0];
        expect(printed.querySelectorAll('.llm-ui-transcript-context, .llm-ui-transcript-note, .llm-ui-transcript-tool')).toHaveLength(0);
        expect(printed.querySelectorAll('pre')).toHaveLength(6);
    } finally { await editor.destroy(); print.mockRestore(); }
});

it('removes context role after explicit provenance is removed on refresh', async () => {
    const {editor, peer, host} = setup();
    const context = {id: 'context', turnId: 'turn', role: 'user' as const, text: 'Original context'};
    vi.mocked(peer.read).mockResolvedValue({...state, messages: [{...context, contentPartKinds: ['agents_md.instructions']}]});
    try {
        await editor.init(host); expect(host.querySelectorAll('.llm-ui-transcript-context')).toHaveLength(1);
        vi.mocked(peer.read).mockResolvedValue({...state, messages: [context]});
        host.querySelector<HTMLButtonElement>('#llm-btn-refresh')!.click();
        await vi.waitFor(() => expect(host.querySelectorAll('.llm-ui-transcript-context')).toHaveLength(0));
        expect(host.querySelector('.llm-ui-session--user')?.textContent).toContain('Original context');
    } finally { await editor.destroy(); }
});

it('restores an unknown image submission across views and clears it only after native reconciliation', async () => {
    const {editor, peer, host} = setup();
    let stored = {revision: '0', data: '', acceptedOperationIds: [] as string[]};
    peer.readComposerDraft = async () => structuredClone(stored);
    peer.saveComposerDraft = async (data, expected, operationId) => {
        if (expected !== stored.revision) throw new Error('ECONFLICT');
        return stored = {data, revision: String(Number(stored.revision) + 1), acceptedOperationIds: [...stored.acceptedOperationIds, operationId]};
    };
    peer.putComposerAsset = async () => 'asset'; peer.readComposerAsset = async () => new ArrayBuffer(0);
    const {ConversationComposer} = await import('../../llm-ui-adapter/src/shell/drafts/conversation-composer');
    const draft = ConversationComposer.create(peer)!; await draft.restore();
    await draft.submit({text: 'Pending original', agentId: 'remote:native', settings: {imageResize: {mode: 'original'}}}, [], 'submission-1');
    vi.mocked(peer.read).mockResolvedValue({...state, pending: true, canSend: false, draft: 'Pending original'});
    await editor.init(host); await editor.destroy();
    const reopened = new RemoteConversationEditor(host, peer, {}); await reopened.init(host);
    try {
        expect(host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!.value).toBe('Pending original');
        expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
        expect(peer.send).not.toHaveBeenCalled();
        vi.mocked(peer.reconcile).mockResolvedValue({...state, submission: {id: 'submission-1', status: 'accepted', turnId: 'new-turn'}, submittedTurnId: 'new-turn', draft: '', pending: false});
        [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t('harness.reconcile'))!.click();
        await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!.value).toBe(''));
        await reopened.flushPendingSave();
        expect(JSON.parse(stored.data).config.text).toBe(''); expect(JSON.parse(stored.data).remoteSubmission).toBeUndefined();
        expect(peer.send).not.toHaveBeenCalled();
    } finally {await reopened.destroy();}
});

function composerStorage(peer: ConversationControls) {
    let stored = {revision: '0', data: '', acceptedOperationIds: [] as string[]};
    const assets = new Map<string, ArrayBuffer>(); let serial = 0;
    peer.readComposerDraft = async () => structuredClone(stored);
    peer.saveComposerDraft = async (data, expected, operationId) => {
        if (expected !== stored.revision) throw Object.assign(new Error('ECONFLICT'), {code: 'ECONFLICT'});
        return stored = {data, revision: String(++serial), acceptedOperationIds: [...stored.acceptedOperationIds, operationId]};
    };
    peer.putComposerAsset = async bytes => {const id = String(++serial); assets.set(id, bytes); return id;};
    peer.readComposerAsset = async id => assets.get(id)!;
    return () => stored;
}
it('keeps acceptance when a subscription clears the composer before the send reply arrives', async () => {
    const {editor, peer, host} = setup(); const stored = composerStorage(peer);
    let notify = () => {}; let current = state;
    peer.subscribe = listener => {notify = listener; return () => {};}; peer.snapshot = () => current;
    peer.send = vi.fn(async (_text, _files, _selection, id) => {
        current = {...state, submission: {id: id!, status: 'accepted', turnId: 'confirmed'}, submittedTurnId: 'confirmed'};
        notify();
        await vi.waitFor(() => expect(JSON.parse(stored().data).remoteSubmission).toBeUndefined());
        return current;
    });
    await editor.init(host);
    try {
        await expect(editor.sendText('Accepted before reply')).resolves.toBeUndefined();
        expect(peer.send).toHaveBeenCalledOnce();
        expect(host.textContent).not.toContain(t('chat.submission.unknown'));
        expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(false);
    } finally {await editor.destroy();}
});
it('queues native follow-ups while running and edits them through the shared queue view', async () => {
    const {editor, peer, host} = setup(); composerStorage(peer);
    const running: ConversationSnapshot = {...state, canSend: false, canQueue: true, canInterrupt: true, active: true,
        instructionQueue: {revision: 1, paused: false, acceptedIds: [], items: []}};
    vi.mocked(peer.read).mockResolvedValue(running);
    peer.enqueue = vi.fn(async (text, _files, _selection, id) => ({...running, instructionQueue: {revision: 2, paused: false,
        acceptedIds: [id!], items: [{id: id!, text, files: [], createdAt: 1, state: 'pending'}]}}));
    peer.editInstructionQueue = vi.fn(async edit => ({...running, instructionQueue: {revision: 3, paused: false, acceptedIds: [],
        items: [{id: 'updated', text: edit.action === 'update' ? edit.text : '', files: [], createdAt: 1, state: 'pending'}]}}));
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        input.value = 'Follow-up'; input.dispatchEvent(new Event('input', {bubbles: true}));
        const send = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
        expect(send.style.display).toBe('flex'); expect(send.disabled).toBe(false); send.click();
        await vi.waitFor(() => expect(peer.enqueue).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(input.value).toBe(''));
        expect(peer.send).not.toHaveBeenCalled(); expect(host.textContent).not.toContain(t('chat.submission.unknown'));
        host.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
        const edit = host.querySelector<HTMLTextAreaElement>('.llm-instruction-queue__editor')!;
        edit.value = 'Revised follow-up'; edit.dispatchEvent(new Event('input', {bubbles: true}));
        host.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
        await vi.waitFor(() => expect(peer.editInstructionQueue).toHaveBeenCalledWith(expect.objectContaining({action: 'update', text: 'Revised follow-up', expectedRevision: 2})));
    } finally {await editor.destroy();}
});

it.each([false, true])('releases the input after native admission while its RPC reply stays pending (composer=%s)', async persistent => {
    const {editor, peer, host} = setup(); if (persistent) composerStorage(peer);
    let current: ConversationSnapshot = {...state, canSend: false, canQueue: true,
        instructionQueue: {revision: 0, paused: false, acceptedIds: [], items: []}};
    const listeners = new Set<() => void>(); let finish!: (state: ConversationSnapshot) => void;
    let original: ConversationSnapshot | undefined, replied = false;
    peer.snapshot = () => current; vi.mocked(peer.read).mockImplementation(async () => current);
    peer.subscribe = listener => {listeners.add(listener); return () => {listeners.delete(listener);};};
    peer.enqueue = vi.fn(async (text, _files, _selection, id) => {
        current = {...current, instructionQueue: {...current.instructionQueue!, revision: current.instructionQueue!.revision + 1,
            acceptedIds: [...current.instructionQueue!.acceptedIds, id!], items: [...current.instructionQueue!.items,
                {id: id!, text, files: [], createdAt: 1, state: 'pending'}]}};
        for (const listener of [...listeners]) listener();
        if (!original) {original = current; const late = await new Promise<ConversationSnapshot>(resolve => {finish = resolve;}); replied = true; return late;}
        return current;
    });
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        const send = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
        const type = (text: string) => {input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));};
        type('First'); send.click(); await vi.waitFor(() => expect(peer.enqueue).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(input.value).toBe(''));
        expect(replied).toBe(false); expect(send.disabled).toBe(false);
        type('Second'); send.click(); await vi.waitFor(() => expect(peer.enqueue).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(input.value).toBe(''));
        type('Third draft'); finish(original!); await new Promise(resolve => setTimeout(resolve, 0));
        expect(input.value).toBe('Third draft'); expect(send.disabled).toBe(false);
        expect(peer.send).not.toHaveBeenCalled();
    } finally {finish?.(current); await editor.destroy();}
});
it('sends declared state queries immediately while serial commands join the native queue', async () => {
    const {editor,peer,host} = setup(); composerStorage(peer);
    const catalog = [{name:'session:status',description:'State',kind:'action' as const,execution:'query' as const,id:'state',revision:'one'},
        {name:'compact',description:'Compact',kind:'action' as const,execution:'serial' as const,revision:'two'}];
    const running: ConversationSnapshot = {...state,canSend:false,canCommand:true,canQueue:true,active:true,canInterrupt:true,
        supportsSlashCommands:true,instructionQueue:{revision:0,paused:false,acceptedIds:[],items:[]}};
    vi.mocked(peer.read).mockResolvedValue(running); peer.commands = vi.fn(async () => catalog);
    peer.command = vi.fn(async (_name,_args,_selection,_text,id) => ({...running,submission:{id:id!,status:'accepted'}}));
    peer.enqueue = vi.fn(async (text,_files,_selection,id) => ({...running,instructionQueue:{revision:1,paused:false,acceptedIds:[id!],
        items:[{id:id!,text,files:[],createdAt:1,state:'pending'}]}}));
    peer.editInstructionQueue = vi.fn(async () => running);
    await editor.init(host);
    try {
        await editor.sendText('/session:status');
        expect(peer.command).toHaveBeenCalledWith('session:status','',undefined,'/session:status',expect.any(String),
            {id:'state',revision:'one',kind:'action',execution:'query'});
        expect(peer.enqueue).not.toHaveBeenCalled();
        await editor.sendText('/compact'); expect(peer.enqueue).toHaveBeenCalledOnce(); expect(peer.send).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});
it.each(['accepted', 'rejected', 'unavailable'] as const)('queries the exact submission after Load failed and the receipt is %s', async outcome => {
    const {editor, peer, host} = setup(), stored = composerStorage(peer);
    vi.mocked(peer.send).mockRejectedValue(new TypeError('Load failed'));
    vi.mocked(peer.reconcile).mockImplementation(async id => {
        if (outcome === 'unavailable') throw new TypeError('Load failed');
        return {...state, submission: {id: id!, status: outcome, ...(outcome === 'accepted' ? {turnId: 'confirmed'} : {code: 'HARNESS_SESSION_BUSY'})},
            ...(outcome === 'accepted' ? {submittedTurnId: 'confirmed'} : {})};
    });
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        input.value = 'Keep input'; input.dispatchEvent(new Event('input'));
        const sending = editor.sendText('Keep input');
        if (outcome === 'accepted') await sending;
        else await expect(sending).rejects.toThrow('Load failed');
        const id = vi.mocked(peer.send).mock.calls[0][3];
        expect(peer.reconcile).toHaveBeenCalledExactlyOnceWith(id);
        expect(peer.send).toHaveBeenCalledOnce();
        expect(input.value).toBe(outcome === 'accepted' ? '' : 'Keep input');
        expect(!!JSON.parse(stored().data).remoteSubmission).toBe(outcome === 'unavailable');
        if (outcome === 'rejected') expect(host.textContent).toContain(t('chat.submission.occupied'));
    } finally {await editor.destroy();}
});
it('recovers a native command receipt after a lost HTTP response without executing it twice', async () => {
    const {editor, peer, host} = setup(), stored = composerStorage(peer);
    vi.mocked(peer.read).mockResolvedValue({...state, supportsSlashCommands: true});
    peer.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    peer.command = vi.fn(async () => {throw new TypeError('Load failed');});
    vi.mocked(peer.reconcile).mockImplementation(async id => ({...state, submission: {id: id!, status: 'accepted'}}));
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        input.value = '/compact'; input.dispatchEvent(new Event('input'));
        await editor.sendText('/compact');
        expect(peer.command).toHaveBeenCalledOnce(); expect(peer.send).not.toHaveBeenCalled();
        expect(peer.reconcile).toHaveBeenCalledExactlyOnceWith(vi.mocked(peer.command).mock.calls[0][4]);
        expect(input.value).toBe(''); expect(JSON.parse(stored().data).remoteSubmission).toBeUndefined();
    } finally {await editor.destroy();}
});
it('preserves newer persisted input across reopening and exact submission reconciliation', async () => {
    const {editor, peer, host} = setup(), stored = composerStorage(peer);
    peer.saveDraft = vi.fn(async () => {throw new Error('Native draft storage must not be used');});
    const {ConversationComposer} = await import('../../llm-ui-adapter/src/shell/drafts/conversation-composer');
    const draft = ConversationComposer.create(peer)!; await draft.restore();
    const config = {text: 'Submitted', agentId: 'remote:native', settings: {}};
    await draft.submit(config, [new File(['sent'], 'sent.txt')], 'submission-1');
    await draft.save({...config, text: 'New unsent input'}, [new File(['new'], 'new.txt')]);
    vi.mocked(peer.read).mockResolvedValue({...state, pending: true, canSend: false, draft: 'Submitted', attachments: ['text']});
    await editor.init(host);
    try {
        vi.mocked(peer.reconcile).mockResolvedValue({...state, submission: {id: 'unrelated', status: 'accepted'}, draft: '', pending: false});
        const reconcile = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t('harness.reconcile'))!;
        reconcile.click(); await vi.waitFor(() => expect(peer.reconcile).toHaveBeenCalledTimes(1));
        expect(host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!.value).toBe('New unsent input');
        expect(JSON.parse(stored().data).remoteSubmission).toMatchObject({id: 'submission-1'});
        vi.mocked(peer.reconcile).mockResolvedValue({...state, submission: {id: 'submission-1', status: 'accepted', turnId: 'turn'}, draft: '', pending: false});
        await vi.waitFor(() => expect(reconcile.disabled).toBe(false)); reconcile.click();
        await vi.waitFor(() => expect(JSON.parse(stored().data).remoteSubmission).toBeUndefined());
        expect(host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!.value).toBe('New unsent input');
        expect(JSON.parse(stored().data).files).toHaveLength(1);
        expect(JSON.parse(stored().data).files[0].name).toBe('new.txt');
        expect(peer.saveDraft).not.toHaveBeenCalled(); expect(peer.send).not.toHaveBeenCalled();
    } finally {await editor.destroy();}
});
it('sends the frozen submission identity and clears only its acknowledged draft', async () => {
    const {editor, peer, host} = setup(), stored = composerStorage(peer);
    peer.send = vi.fn(async (_text, _attachments, _selection, id) => ({...state, draft: '', submission: {id: id!, status: 'accepted' as const, turnId: 'turn'}}));
    await editor.init(host);
    try {
        const input = host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!;
        input.value = 'Prompt'; input.dispatchEvent(new Event('input', {bubbles: true}));
        await editor.commands.sendMessage({text: 'Prompt'});
        expect(peer.send).toHaveBeenCalledWith('Prompt', [], undefined, expect.any(String));
        expect(input.value).toBe(''); expect(JSON.parse(stored().data).remoteSubmission).toBeUndefined();
    } finally {await editor.destroy();}
});

it('restores command reconciliation without inventing a temporary user message', async () => {
    const {editor, peer, host} = setup(), stored = composerStorage(peer);
    const {ConversationComposer} = await import('../../llm-ui-adapter/src/shell/drafts/conversation-composer');
    const draft = ConversationComposer.create(peer)!; await draft.restore();
    await draft.submit({text: '/compact', agentId: 'remote:native', settings: {}}, [], 'command-1', 'command');
    vi.mocked(peer.read).mockResolvedValue({...state, pending: true, canSend: false}); await editor.init(host);
    try {
        expect(host.querySelectorAll('.llm-ui-session--user')).toHaveLength(0);
        vi.mocked(peer.reconcile).mockResolvedValue({...state, draft: '', submission: {id: 'command-1', status: 'accepted'}});
        [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === t('harness.reconcile'))!.click();
        await vi.waitFor(() => expect(JSON.parse(stored().data).remoteSubmission).toBeUndefined());
        expect(peer.reconcile).toHaveBeenCalledWith('command-1');
        expect(host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!.value).toBe('');
    } finally {await editor.destroy();}
});

it('offers an explicit draft reload after a CAS conflict and permits saving again', async () => {
    const {editor, peer, host} = setup(), stored = composerStorage(peer); await editor.init(host);
    const {ConversationComposer} = await import('../../llm-ui-adapter/src/shell/drafts/conversation-composer');
    const other = ConversationComposer.create(peer)!; await other.restore();
    await other.save({text: 'Other window', agentId: 'remote:native', settings: {}}, []);
    const input = host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!;
    input.value = 'Stale input'; input.dispatchEvent(new Event('input', {bubbles: true}));
    try {
        await expect(editor.flushPendingSave()).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(input.value).toBe('Stale input'); host.querySelector<HTMLButtonElement>('[data-reload-composer]')!.click();
        await vi.waitFor(() => expect(input.value).toBe('Other window'));
        input.value = 'After explicit reload'; input.dispatchEvent(new Event('input', {bubbles: true})); await editor.flushPendingSave();
        expect(JSON.parse(stored().data).config.text).toBe('After explicit reload');
    } finally {await editor.destroy();}
});

it('keeps stop and control reconciliation usable while the original send reply is suspended', async () => {
    const {editor, peer, host} = setup(); let changed!: () => void, finish!: (value: ConversationSnapshot) => void;
    let current = state;
    peer.snapshot = () => current; peer.subscribe = listener => {changed = listener; return () => {};};
    vi.mocked(peer.read).mockImplementation(async () => current);
    vi.mocked(peer.send).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    peer.reconcileControl = vi.fn(async () => current);
    vi.mocked(peer.interrupt).mockImplementation(async () => {
        current = {...current, canInterrupt: false, controls: [{operationId: 'stop', sessionId: 's', turnId: 't', receipt: 'unknown', effect: 'unconfirmed'}]}; return current;
    });
    await editor.init(host); const sending = editor.commands.sendMessage({text: 'Original'});
    try {
        await vi.waitFor(() => expect(peer.send).toHaveBeenCalledOnce());
        current = {...current, canSend: false, canInterrupt: true, active: true, pending: true}; changed();
        const stop = host.querySelector<HTMLButtonElement>('.llm-input__btn--stop')!;
        await vi.waitFor(() => expect(stop.disabled).toBe(false)); stop.click();
        await vi.waitFor(() => expect(peer.interrupt).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(host.textContent).toContain(t('harness.controlUnknown')));
        const reconcile = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes(t('harness.reconcile')));
        expect(reconcile).toBeDefined(); expect(reconcile!.disabled).toBe(false); reconcile!.click();
        await vi.waitFor(() => expect(peer.reconcileControl).toHaveBeenCalledOnce());
    } finally {finish(current); await sending.catch(() => {}); await editor.destroy();}
});
