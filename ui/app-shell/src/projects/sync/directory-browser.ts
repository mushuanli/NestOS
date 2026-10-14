import { t } from '@itookit/common';
import type { SyncDialog } from './dialog';
/** Browse only project-relative directories; stale results cannot replace a new selection. */
export function installDirectoryBrowser(dialog: SyncDialog,parent: HTMLElement,projects: HTMLSelectElement,path: HTMLInputElement,
    browse: (projectId: string,path: string)=>Promise<string[]>,signal: AbortSignal): void {
    const panel=document.createElement('div');panel.className='project-sync__directories';let version=0;
    const load=async(target: string)=> {
        const id=projects.value,request=++version;const paths=await browse(id,target);
        if (signal.aborted || request!==version || id!==projects.value || path.dataset.unavailable==='true' || !panel.isConnected) return;
        panel.replaceChildren();path.value=target;
        for (const child of paths) {
            const item=document.createElement('button');item.type='button';item.textContent=child;
            item.onclick=()=>{void dialog.run(()=>load(child),true);};panel.append(item);
        }
        if (!paths.length) {const empty=document.createElement('p');empty.textContent=t('remote.directoryEmpty');panel.append(empty);}
    };
    const button=(label: string,target: ()=>string)=> {
        const item=document.createElement('button');item.type='button';item.textContent=label;
        item.onclick=()=>{if (!path.disabled) void dialog.run(()=>load(target()),true);};parent.append(item);
    };
    button(t('remote.directoryBrowse'),()=>path.value.trim());button(t('remote.directoryUp'),()=>path.value.includes('/')?path.value.slice(0,path.value.lastIndexOf('/')):'');
    projects.addEventListener('change',()=>{version++;path.value='';panel.replaceChildren();});
    path.addEventListener('input',()=>{version++;panel.replaceChildren();});parent.append(panel);
}
