import { t } from '@itookit/common';
import type { DirectorySyncBinding, DirectorySyncPlan, DirectorySyncDirection, DirectorySyncComparison, DirectorySyncConflict } from '@itookit/piagent-driver';
import { SyncDialog, paragraph } from './dialog';
import { directionSelect, renderChanges, conflictReason, resolutionToolbar } from './controls';
import { conflictMetadata, renderComparison } from './comparison';
import { installDirectoryBrowser } from './directory-browser';
export interface DirectorySyncPorts {
    advanced?: boolean;
    targets(): Promise<Array<{id: string; name: string}>>;
    status(): Promise<DirectorySyncBinding | null>;
    bind(projectId: string,target: string,direction?: DirectorySyncDirection): Promise<DirectorySyncBinding>;
    preview(): Promise<DirectorySyncPlan>;
    execute(planId: string): Promise<DirectorySyncPlan>;
    unbind(): Promise<void>;
    upload(): Promise<void>;
    configure?(revision: number,direction: DirectorySyncDirection): Promise<DirectorySyncBinding>;
    resolve?(planId: string,decisions: Record<string,'dataset'|'directory'>): Promise<DirectorySyncPlan>;
    compare?(planId: string,path: string): Promise<DirectorySyncComparison>;
    browse?(projectId: string,path: string): Promise<string[]>;
}
interface View {
    dialog: SyncDialog; targets: HTMLSelectElement; path: HTMLInputElement; preview: HTMLElement; direction: HTMLSelectElement;
    binding: DirectorySyncBinding | null; buttons: Map<string,HTMLButtonElement>; choices: Map<string,HTMLSelectElement>;
    advanced: boolean; valid: boolean; signal: AbortSignal;
}
export function showDirectorySync(ports: DirectorySyncPorts,signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve=>mount(ports,signal,resolve));
}
function mount(ports: DirectorySyncPorts,signal: AbortSignal,closed: () => void): void {
    const view=createView(ports,signal,closed);installActions(ports,view);view.dialog.open();
    void view.dialog.run(async()=> {
        const items=await ports.targets();if (signal.aborted) return;
        for (const item of items) {const option=document.createElement('option');option.value=item.id;option.textContent=item.name;view.targets.append(option);}
        await refreshBinding(ports,view);view.dialog.message('');
    },true);
}
function createView(ports: DirectorySyncPorts,signal: AbortSignal,closed: () => void): View {
    const dialog=new SyncDialog(t('project.sync.directory'),signal,closed),controls=document.createElement('div'),preview=document.createElement('div');
    dialog.body.append(controls,preview);
    const targets=document.createElement('select');targets.setAttribute('aria-label',t('project.sync.directoryProject'));
    const path=document.createElement('input');path.placeholder=t('project.sync.directoryRoot');path.setAttribute('aria-label',t('project.sync.directoryPath'));
    field(controls,t('project.sync.directoryProject'),targets);field(controls,t('project.sync.directoryPath'),path);
    if (ports.browse) installDirectoryBrowser(dialog,controls,targets,path,ports.browse,signal);
    const direction=directionSelect(controls,'download',true),advanced=ports.advanced ?? !!ports.configure;
    if (!advanced) {for (const option of direction.options) option.disabled=option.value!=='download';paragraph(controls,t('project.sync.directoryUpgrade'));}
    paragraph(controls,t('project.sync.directoryHint'));
    return {dialog,targets,path,preview,direction,binding:null,buttons:new Map(),choices:new Map(),advanced,valid:true,signal};
}
function field(parent: HTMLElement,text: string,input: HTMLElement): void {const label=document.createElement('label');label.textContent=text;label.append(input);parent.append(label);}
function installActions(ports: DirectorySyncPorts,view: View): void {
    const button=(name: string,key: Parameters<typeof t>[0],action: () => Promise<void>)=>{view.buttons.set(name,view.dialog.button(t(key),action));};
    button('upload','project.sync.directoryUpload',ports.upload);
    button('bind','project.sync.bindConfirm',async()=> {
        const path=view.path.value.trim();if (path && (path.startsWith('/') || path.split('/').some(p=>!p || p==='.' || p==='..' || p==='.mindos'))) throw new Error(t('project.sync.invalidTargetPath'));
        view.binding=await ports.bind(view.targets.value,path,view.direction.value as DirectorySyncDirection);render(ports,view);view.dialog.message(t('project.sync.directoryBound'));
    });
    button('preview','project.sync.refreshPreview',async()=> {
        view.valid=false;render(ports,view);await ports.preview();await refreshBinding(ports,view);view.dialog.message(t('project.sync.previewHint'));
    });
    button('execute','project.sync.execute',()=>execute(ports,view));
    button('unbind','project.sync.unbindConfirm',async()=> {await ports.unbind();view.binding=null;render(ports,view);});
    button('status','project.sync.directoryRefresh',async()=> {await refreshBinding(ports,view);view.dialog.message('');});
    view.direction.onchange=()=> {
        if (!view.binding || !view.advanced || !ports.configure) return;
        view.valid=false;render(ports,view);
        void view.dialog.run(async()=> {
            view.binding=await ports.configure!(view.binding!.policyRevision ?? 0,view.direction.value as DirectorySyncDirection);
            await ports.preview();await refreshBinding(ports,view);view.dialog.message(t('project.sync.directionReview'));
        });
    };
    for (const name of ['bind','preview','execute','unbind']) view.buttons.get(name)!.dataset.unavailable='true';
}
async function refreshBinding(ports: DirectorySyncPorts,view: View): Promise<void> {
    view.binding=await ports.status();view.valid=true;
    if (view.binding) {view.targets.value=view.binding.projectId;view.path.value=view.binding.target;view.direction.value=view.binding.direction ?? 'download';}
    render(ports,view);
}
async function execute(ports: DirectorySyncPorts,view: View): Promise<void> {
    const plan=view.binding?.plan;if (!plan || !view.valid) return;
    const decisions=Object.fromEntries([...view.choices].filter(([,s])=>s.value).map(([p,s])=>[p,s.value])) as Record<string,'dataset'|'directory'>;
    if (Object.keys(decisions).length && ports.resolve) {
        const next=await ports.resolve(plan.id,decisions);view.binding!.plan=next;render(ports,view);
        view.dialog.message(t('project.sync.reviewDecisions'));return;
    }
    const result=await ports.execute(plan.id);await refreshBinding(ports,view);
    view.dialog.message(t(result.state==='complete'?'project.sync.directoryDone':'project.sync.directoryPending'));
}
function render(ports: DirectorySyncPorts,view: View): void {
    const {binding,targets,path,buttons}=view,plan=binding?.plan ?? null,pending=plan?.state==='applying';
    view.preview.replaceChildren();view.choices.clear();
    if (binding) paragraph(view.preview,`${targets.selectedOptions[0]?.textContent ?? t('project.sync.directoryProject')} / ${binding.target || '.'}`);
    if (plan) renderPlan(ports,view,plan);
    for (const input of [targets,path]) {input.disabled=!!binding;input.dataset.unavailable=String(!!binding);}
    view.direction.dataset.unavailable=String(pending || (!!binding && !view.advanced));
    buttons.get('bind')!.dataset.unavailable=String(!!binding || !targets.options.length);
    buttons.get('upload')!.dataset.unavailable=String(pending);
    buttons.get('unbind')!.dataset.unavailable=String(!binding || pending);
    buttons.get('preview')!.dataset.unavailable=String(!binding || pending);
    updateExecute(view);
}
function updateExecute(view: View): void {
    const plan=view.binding?.plan,selected=[...view.choices.values()].filter(s=>s.value).length;
    const disabled=!view.valid || !plan || ['complete','rejected'].includes(plan.state) || (!!plan.conflicts.length && !selected);
    const button=view.buttons.get('execute')!;button.dataset.unavailable=String(disabled);button.disabled=disabled;
}
function renderPlan(ports: DirectorySyncPorts,view: View,plan: DirectorySyncPlan): void {
    paragraph(view.preview,t(plan.state==='applying'?'project.sync.directoryPending':plan.state==='complete'?'project.sync.directoryDone':'project.sync.previewHint'));
    renderChanges(view.preview,plan.actions.map(a=>({path:a.path,side:a.side ?? 'download',operation:a.before?'update':'create'})),plan.conflicts.length,true);
    for (const path of plan.conflicts) {
        const detail=plan.conflictDetails?.find(c=>c.path===path);
        if (detail) renderConflict(ports,view,plan,detail);
        else paragraph(view.preview,t('project.sync.directoryConflict',{path}));
    }
    if (view.choices.size) resolutionToolbar(view.preview,view.choices,plan.direction ?? 'download',true,()=>updateExecute(view));
}
function renderConflict(ports: DirectorySyncPorts,view: View,plan: DirectorySyncPlan,conflict: DirectorySyncConflict): void {
    const card=document.createElement('section');card.className='project-sync__conflict';paragraph(card,`${conflict.path} · ${conflictReason(conflict.code)}`);
    card.dataset.syncPath=conflict.path;
    const labels: [string,string]=[t('project.sync.datasetVersion'),t('project.sync.directoryVersion')];
    conflictMetadata(card,labels,[conflict.dataset,conflict.directory]);
    if (conflict.resolvable && ports.resolve) {
        const select=document.createElement('select');select.setAttribute('aria-label',conflict.path);
        for (const choice of ['', 'dataset','directory'] as const) {
            const option=document.createElement('option');option.value=choice;option.textContent=t(choice==='dataset'?'project.sync.useDataset':choice==='directory'?'project.sync.useDirectory':'project.sync.unresolved');
            option.disabled=(choice==='dataset' && (plan.direction==='upload' || !conflict.dataset)) || (choice==='directory' && (plan.direction==='download' || !conflict.directory));select.append(option);
        }
        select.onchange=()=>updateExecute(view);view.choices.set(conflict.path,select);card.append(select);
    }
    if (ports.compare && view.advanced && plan.state==='ready' && conflict.resolvable) {
        const button=document.createElement('button'),output=document.createElement('div');button.type='button';button.textContent=t('project.sync.compareContent');card.append(button,output);
        button.onclick=()=> {void view.dialog.run(async()=> {
            const result=await ports.compare!(plan.id,conflict.path);
            if (card.isConnected && !view.signal.aborted && view.binding?.plan?.id===plan.id) renderComparison(output,result.baseline,result.dataset,result.directory,labels);
        });};
    }
    view.preview.append(card);
}
