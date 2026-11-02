import type {PromptBundle} from './prompt-bundle';
export const LIFECYCLE_PROMPT_SUFFIXES=['pre','post','succ','fail','cancel','clear'] as const;
/** Names are configuration; neither the execution transport nor the agent interprets application state. */
export function lifecyclePromptFiles(bundle:PromptBundle,entry:string,phase:'pre'|'succeeded'|'failed'|'cancelled'):string[] {
    const suffixes=phase==='pre'?['pre']:['post',{succeeded:'succ',failed:'fail',cancelled:'cancel'}[phase],'clear'];
    return suffixes.map(suffix=>entry+'-'+suffix+'.md').filter(name=>bundle.files.some(file=>file.name===name));
}
