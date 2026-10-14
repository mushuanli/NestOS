// @vitest-environment jsdom
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { t } from '@itookit/common';
import { showDirectorySync,type DirectorySyncPorts } from '../src/projects/sync/directory';
import type { DirectorySyncBinding,DirectorySyncPlan } from '@itookit/piagent-driver';
const plan:DirectorySyncPlan={id:'plan',manifestHash:'hash',generation:'1',state:'ready',actions:[],conflicts:['note.txt'],accepted:{}};
const binding:DirectorySyncBinding={id:'b',projectId:'p',revision:1,syncProjectId:'s',datasetId:'files',historyEpoch:'e',target:'',baseline:{},plan};
beforeEach(()=> {for (const name of ['showModal','close']) Object.defineProperty(HTMLDialogElement.prototype,name,{configurable:true,value:vi.fn()});});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
function ports(value:DirectorySyncBinding|null):DirectorySyncPorts {return {targets:async()=>[{id:'p',name:'Native'}],status:vi.fn(async()=>value),bind:vi.fn(async()=>binding),preview:vi.fn(async()=>plan),execute:vi.fn(async()=>plan),unbind:vi.fn(async()=>{}),upload:vi.fn(async()=>{})};}
async function ready(){await vi.waitFor(()=>expect(document.querySelector('[role=status]')?.textContent).toBe(''));}
function button(label:string){return [...document.querySelectorAll('button')].find(b=>b.textContent===label)!;}
it('blocks conflicting plans and does not apply when a preview is opened or closed',async()=>{
    const p=ports(binding),controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    expect(document.body.textContent).toContain('note.txt');expect(button(t('project.sync.execute')).disabled).toBe(true);
    expect(p.execute).not.toHaveBeenCalled();controller.abort();await closed;expect(p.execute).not.toHaveBeenCalled();
});
it('resumes the retained applying plan without generating another preview',async()=>{
    const retained={...plan,state:'applying' as const,conflicts:[]};const p=ports({...binding,plan:retained});
    const controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    expect(button(t('project.sync.refreshPreview')).disabled).toBe(true);button(t('project.sync.execute')).click();
    await vi.waitFor(()=>expect(p.execute).toHaveBeenCalledWith('plan'));expect(p.preview).not.toHaveBeenCalled();controller.abort();await closed;
});
it('binds the selected subdirectory while keeping directory selection fixed afterwards',async()=>{
    const p=ports(null),controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    const input=document.querySelector('input')!;input.value='nested';button(t('project.sync.bindConfirm')).click();
    await vi.waitFor(()=>expect(p.bind).toHaveBeenCalledWith('p','nested','download'));expect(p.execute).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(input.disabled).toBe(true));controller.abort();await closed;
});
it('compares conflict content and requires review after selecting the directory version',async()=>{
    const detail={path:'note.txt',code:'CONTENT_CONFLICT',baseline:null,dataset:{kind:'file' as const,hash:'dataset',executable:false,identity:null},directory:{kind:'file' as const,hash:'native',executable:false,identity:null},resolvable:true};
    const initial={...plan,direction:'both' as const,conflictDetails:[detail]},value={...binding,direction:'both' as const,policyRevision:1,plan:initial};
    const resolved={...initial,id:'resolved',conflicts:[],conflictDetails:[],actions:[{path:'note.txt',before:detail.dataset,after:detail.directory,side:'upload' as const}]};
    const p={...ports(value),advanced:true,compare:vi.fn(async()=>({path:'note.txt',baseline:{kind:'missing' as const},dataset:{kind:'file' as const,content:{text:'<script>dataset</script>\n'}},directory:{kind:'file' as const,content:{text:'native\n'}}})),resolve:vi.fn(async()=>resolved)};
    const controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    button(t('project.sync.compareContent')).click();await vi.waitFor(()=>expect(document.querySelectorAll('pre').length).toBe(2));
    expect(document.querySelector('script')).toBeNull();expect(document.body.textContent).toContain('native');expect(p.execute).not.toHaveBeenCalled();
    const select=document.querySelector<HTMLSelectElement>('select[aria-label="note.txt"]')!;select.value='directory';select.dispatchEvent(new Event('change'));
    button(t('project.sync.execute')).click();await vi.waitFor(()=>expect(p.resolve).toHaveBeenCalledWith('plan',{'note.txt':'directory'}));
    expect(p.execute).not.toHaveBeenCalled();await vi.waitFor(()=>expect(button(t('project.sync.execute')).disabled).toBe(false));
    button(t('project.sync.execute')).click();await vi.waitFor(()=>expect(p.execute).toHaveBeenCalledWith('resolved'));controller.abort();await closed;
});
it('invalidates the old plan when changing direction and does not publish automatically',async()=>{
    let value:DirectorySyncBinding={...binding,direction:'download',policyRevision:1,plan:{...plan,conflicts:[]}};
    const p={...ports(value),advanced:true,status:vi.fn(async()=>value),configure:vi.fn(async(_revision:number,direction:'both'|'upload'|'download')=>value={...value,direction,policyRevision:2,plan:null}),preview:vi.fn(async()=>{value.plan={...plan,id:'new',conflicts:[],direction:value.direction};return value.plan;})};
    const controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    const direction=document.querySelector<HTMLSelectElement>(`select[aria-label="${t('project.sync.direction')}"]`)!;
    direction.value='upload';direction.dispatchEvent(new Event('change'));expect(button(t('project.sync.execute')).disabled).toBe(true);
    await vi.waitFor(()=>expect(p.configure).toHaveBeenCalledWith(1,'upload'));await vi.waitFor(()=>expect(p.preview).toHaveBeenCalledOnce());
    expect(p.execute).not.toHaveBeenCalled();expect(direction.value).toBe('upload');controller.abort();await closed;
});
it('blocks unsupported directions for an older server',async()=>{
    const p={...ports(binding),advanced:false},controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    const direction=document.querySelector<HTMLSelectElement>(`select[aria-label="${t('project.sync.direction')}"]`)!;
    expect(direction.querySelector<HTMLOptionElement>('option[value="upload"]')!.disabled).toBe(true);expect(document.body.textContent).toContain(t('project.sync.directoryUpgrade'));
    controller.abort();await closed;
});
it('browses subdirectories and binds the selected project-relative path',async()=>{
    const p={...ports(null),browse:vi.fn(async(_project:string,path:string)=>path?[]:['src'])};
    const controller=new AbortController(),closed=showDirectorySync(p,controller.signal);await ready();
    button(t('remote.directoryBrowse')).click();await vi.waitFor(()=>expect(p.browse).toHaveBeenCalledWith('p',''));
    await vi.waitFor(()=>expect(button('src')).toBeTruthy());button('src').click();await vi.waitFor(()=>expect(p.browse).toHaveBeenCalledWith('p','src'));
    await vi.waitFor(()=>expect(document.querySelector<HTMLInputElement>(`input[aria-label="${t('project.sync.directoryPath')}"]`)!.value).toBe('src'));
    button(t('project.sync.bindConfirm')).click();await vi.waitFor(()=>expect(p.bind).toHaveBeenCalledWith('p','src','download'));
    controller.abort();await closed;
});
