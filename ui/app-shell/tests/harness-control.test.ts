// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessClient } from '@itookit/app-core';
import { t } from '@itookit/common';
import { showHarnessControl } from '../src/harness/control';

const session = { id:'s',title:'<script>title</script>',cwd:'/workspace',status:'idle',updatedAt:1,resumable:true };
const descriptors = new Map<string,PropertyDescriptor | undefined>();
beforeEach(() => {
    for (const method of ['showModal','close']) {
        descriptors.set(method,Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,method));
        Object.defineProperty(HTMLDialogElement.prototype,method,{ configurable:true,value:vi.fn() });
    }
});
afterEach(() => {
    document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers();
    for (const [method,descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype,method,descriptor);
        else delete (HTMLDialogElement.prototype as unknown as Record<string,unknown>)[method];
    }
});
const settle = async () => { for (let i=0;i<15;i++) await Promise.resolve(); };
function client(): HarnessClient {
    return { profiles:vi.fn(async () => ({ epoch:'e',profiles:[{ id:'codex',kind:'codex',workspaces:[{id:'project'}],
        capabilities:{ history:true,create:true,resume:true,interrupt:true,interactions:true } }] })),
        list:vi.fn(async () => ({ sessions:[session],nextCursor:null })),
        read:vi.fn(async () => ({ session,turns:[{ items:[{ type:'agentMessage',text:'<script>history</script>' }] }] })),
        create:vi.fn(async () => ({session})),resume:vi.fn(async () => ({session})),turn:vi.fn(async () => ({turnId:'t'})),
        events:vi.fn(async () => ({epoch:'ev',cursor:0,gap:false,events:[],requests:[]})),interrupt:vi.fn(async () => {}),
        respond:vi.fn(async () => {}),operation:vi.fn(),close:vi.fn(async () => {}) };
}
function button(text: string): HTMLButtonElement {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!;
}
it('renders histories safely, resumes before sending, and leaves running turns intact when closed',async () => {
    const controller = new AbortController(), peer = client();
    const opened = showHarnessControl(peer,'node',controller.signal); await settle();
    button(session.title).click(); await settle();
    expect(document.querySelector('script')).toBeNull(); expect(document.querySelector('pre')?.textContent).toContain('<script>history</script>');
    document.querySelector('textarea')!.value = 'task';
    document.querySelector('form')!.dispatchEvent(new Event('submit',{ cancelable:true })); await settle();
    expect(peer.resume).toHaveBeenCalledWith('codex','s',expect.anything()); expect(peer.turn).toHaveBeenCalledWith('codex','s','task',expect.anything());
    controller.abort(); await opened;
    expect(peer.close).toHaveBeenCalledOnce(); expect(peer.interrupt).not.toHaveBeenCalled(); expect(document.querySelector('dialog')).toBeNull();
});
it('disables execution for history-only sessions and blocks replay of an unknown creation',async () => {
    const controller = new AbortController(), peer = client();
    vi.mocked(peer.read).mockResolvedValue({session:{...session,resumable:false},turns:[]});
    vi.mocked(peer.create).mockRejectedValue({outcome:'unknown',requestId:'lost'});
    const opened = showHarnessControl(peer,'node',controller.signal); await settle();
    button(session.title).click(); await settle(); expect(button(t('harness.send')).disabled).toBe(true);
    button(t('harness.create')).click(); await settle(); button(t('harness.create')).click(); await settle();
    expect(peer.create).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('lost');
    controller.abort(); await opened;
});

it('keeps an early completion from being overwritten by a late turn response',async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), peer = client();
    let finish!: (value: {turnId:string}) => void;
    vi.mocked(peer.turn).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const opened = showHarnessControl(peer,'node',controller.signal); await settle();
    button(session.title).click(); await settle();
    document.querySelector('textarea')!.value = 'quick task';
    document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true})); await settle();
    vi.mocked(peer.events).mockResolvedValue({epoch:'ev',cursor:1,gap:false,requests:[],events:[
        {seq:1,message:{method:'turn/completed',params:{threadId:'s',turn:{id:'quick'}}}}]});
    await vi.advanceTimersByTimeAsync(500); expect(button(t('harness.send')).disabled).toBe(true);
    finish({turnId:'quick'}); await settle();
    expect(button(t('harness.send')).disabled).toBe(false); expect(button(t('harness.interrupt')).disabled).toBe(true);
    controller.abort(); await opened; vi.useRealTimers();
});
it('adopts a confirmed creation without submitting it again',async () => {
    const controller = new AbortController(), peer = client();
    vi.mocked(peer.create).mockRejectedValue({outcome:'unknown',requestId:'lost'});
    vi.mocked(peer.operation).mockResolvedValue({outcome:'committed',requestId:'lost',result:{session}});
    const opened = showHarnessControl(peer,'node',controller.signal); await settle();
    button(t('harness.create')).click(); await settle();
    button(t('harness.reconcile')).click(); await settle();
    expect(peer.create).toHaveBeenCalledOnce(); expect(peer.read).toHaveBeenCalledWith('codex','s',expect.anything());
    document.querySelector('textarea')!.value = 'continue';
    document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true})); await settle();
    expect(peer.resume).not.toHaveBeenCalled(); expect(peer.turn).toHaveBeenCalledOnce();
    controller.abort(); await opened;
});
