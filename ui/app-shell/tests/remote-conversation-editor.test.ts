// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteConversationEditor } from '../../llm-ui/src/shell/RemoteConversationEditor';
import type { ConversationControls, ConversationSnapshot, EditorOptions } from '@itookit/ui-common';
import { LLMPrintService } from '@itookit/mdx-adapter';
import { t } from '@itookit/common';
const state: ConversationSnapshot = {sessionId:'s',title:'remote',branchName:'main',messages:[{id:'1',role:'assistant',text:'<script>native</script>',turnId:'initial-turn'}],requests:[],canSend:true,canInterrupt:false,canRespond:false,pending:false,disconnected:false,gap:false};
function setup(options: EditorOptions = {}) {
    const peer: ConversationControls = {read:vi.fn(async () => state),poll:vi.fn(async () => state),send:vi.fn(async () => ({...state,canSend:false,canInterrupt:true})),interrupt:vi.fn(async () => state),respond:vi.fn(async () => state),reconcile:vi.fn(async () => state),close:vi.fn(async () => {})};
    const host=document.createElement('div');document.body.append(host);
    const editor=new RemoteConversationEditor(host,peer,{title:'Server · Project · Codex', ...options});return {editor,peer,host};
}
beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches:false,addEventListener() {},removeEventListener() {}}));
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: vi.fn()});
    Object.defineProperties(Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new DOMRect()}});
});
afterEach(() => {document.body.replaceChildren();vi.useRealTimers();vi.unstubAllGlobals();delete (Range.prototype as any).getClientRects;delete (Range.prototype as any).getBoundingClientRect;delete (HTMLElement.prototype as any).scrollIntoView;});
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
it('preserves failed input and offers reconciliation instead of repeating an unknown operation', async () => {
    const {editor,peer,host}=setup();await editor.init(host);
    vi.mocked(peer.send).mockRejectedValue({outcome:'unknown'});vi.mocked(peer.read).mockResolvedValue({...state,pending:true,canSend:false});
    host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value='keep draft';await expect(editor.sendText('keep draft')).rejects.toBeDefined();
    expect(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value).toBe('keep draft');
    expect(host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled).toBe(true);
    await expect(editor.sendText('keep draft')).rejects.toThrow();expect(peer.send).toHaveBeenCalledOnce();await editor.destroy();
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
    await editor.init(host);expect(host.querySelector('[role="status"]')?.textContent).toContain('Native path unavailable');
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
    const history = host.querySelector<HTMLButtonElement>('#llm-btn-history-visibility')!;
    history.click(); expect(menu.open).toBe(false); expect(host.querySelector<HTMLElement>('#llm-ui-history')!.hidden).toBe(true);
    history.click(); expect(host.querySelector<HTMLElement>('#llm-ui-history')!.hidden).toBe(false);
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
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toContain(t('chat.submission.unknown')));
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
    vi.mocked(peer.poll).mockResolvedValue({...state, hasEarlier: true});
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
    expect(host.querySelector('[role="status"]')?.textContent).toContain(t('chat.submission.unknown'));
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

it('enables native title editing only when the injected port grants rename', async () => {
    const {editor, peer, host} = setup();
    peer.rename = vi.fn(async title => ({...state, title, canRename: true}));
    vi.mocked(peer.read).mockResolvedValue({...state, canRename: true}); await editor.init(host);
    const title = host.querySelector<HTMLInputElement>('#llm-title-input')!;
    expect(title.readOnly).toBe(false); title.value = 'Changed native title'; title.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(peer.rename).toHaveBeenCalledExactlyOnceWith('Changed native title'));
    await editor.destroy();
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
