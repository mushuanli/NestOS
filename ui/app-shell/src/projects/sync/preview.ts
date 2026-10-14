import { t } from '@itookit/common';
import type { ProjectSyncService } from '@itookit/app-contracts/services';
import type { StoredFilePlan, FileConflict } from '@itookit/vfs-sync';
import { SyncDialog, paragraph } from './dialog';
import { directionSelect, renderChanges, conflictReason, resolutionToolbar, type SyncDirection } from './controls';
import { conflictMetadata, renderComparison } from './comparison';

export function syncPreview(value: unknown): StoredFilePlan {
    const preview = value as StoredFilePlan;
    if (!preview?.id || !Array.isArray(preview.plan?.actions) || !Array.isArray(preview.plan?.conflicts)) throw new Error('INVALID_SYNC_PREVIEW');
    return preview;
}
export function showSyncPreview(service: ProjectSyncService, projectId: string, initial: StoredFilePlan,
    signal: AbortSignal, changed: (remaining: number) => Promise<void>, direction: SyncDirection = 'both'): void {
    new SyncPreviewView(service,projectId,initial,signal,changed,direction).open();
}
class SyncPreviewView {
    private readonly dialog: SyncDialog;
    private readonly planBody=document.createElement('div');
    private readonly choices=new Map<string,HTMLSelectElement>();
    private readonly executeButton: HTMLButtonElement;
    private readonly mergeButton: HTMLButtonElement;
    private valid=true;
    private directionInput?: HTMLSelectElement;
    constructor(private readonly service: ProjectSyncService,private readonly projectId: string,private current: StoredFilePlan,
        private readonly signal: AbortSignal,private readonly changed: (remaining: number) => Promise<void>,private direction: SyncDirection) {
        this.dialog=new SyncDialog(t('project.sync.preview'),signal);
        if (typeof service.configure==='function') this.installDirection();
        this.dialog.body.append(this.planBody);
        this.dialog.button(t('project.sync.refreshPreview'),()=>this.refresh());
        this.mergeButton=this.dialog.button(t('project.sync.merge'),()=>this.merge());
        this.executeButton=this.dialog.button(t('project.sync.execute'),()=>this.execute());
        this.render();
    }
    open(): void { this.dialog.open(); }
    private installDirection(): void {
        const select=directionSelect(this.dialog.body,this.direction);
        this.directionInput=select;
        select.onchange=()=> {
            this.valid=false;this.executeButton.disabled=true;this.executeButton.dataset.unavailable='true';
            void this.dialog.run(async () => {
                await this.service.configure(this.projectId,this.current.bindingToken,{direction:select.value as SyncDirection});
                this.direction=select.value as SyncDirection;await this.refresh();await this.changed(this.current.plan.conflicts.length);
                this.dialog.message(t('project.sync.directionReview'));
            });
        };
    }
    private async refresh(): Promise<void> {
        this.valid=false;this.executeButton.dataset.unavailable='true';
        if (this.directionInput && typeof this.service.status==='function') {
            this.direction=(await this.service.status(this.projectId)).binding.direction;this.directionInput.value=this.direction;
        }
        this.current=syncPreview(await this.service.preview(this.projectId));this.valid=true;this.render();this.dialog.message(t('project.sync.previewHint'));
    }
    private async merge(): Promise<void> {
        this.current=syncPreview(await this.service.mergeText(this.projectId,this.current.id,mergePaths(this.current)));
        this.render();this.dialog.message(t('project.sync.reviewMerge'));
    }
    private async execute(): Promise<void> {
        if (!this.valid) return;
        const decisions=Object.fromEntries([...this.choices].filter(([,s])=>s.value).map(([path,s])=>[path,s.value])) as Record<string,'local'|'remote'>;
        if (Object.keys(decisions).length) {
            this.current=syncPreview(await this.service.resolve(this.projectId,this.current.id,decisions));this.render();
            this.dialog.message(t('project.sync.reviewDecisions'));return;
        }
        const result=await this.service.execute(this.projectId,this.current.id);
        const remaining=result.conflicts?.length ?? this.current.plan.conflicts.length;await this.changed(remaining);
        for (const warning of result.warnings ?? []) paragraph(this.planBody,warning);
        this.dialog.message(t(remaining?'project.sync.partial':'project.sync.completed',{count:remaining}));
        this.dialog.actions.replaceChildren();this.dialog.button(t('project.sync.close'),async()=>this.dialog.close());
        for (const input of this.dialog.body.querySelectorAll('select,input,button')) (input as HTMLInputElement).dataset.unavailable='true';
    }
    private render(): void {
        this.planBody.replaceChildren();this.choices.clear();paragraph(this.planBody,t('project.sync.previewHint'));
        renderChanges(this.planBody,this.current.plan.actions.map(a=>({path:a.path,side:a.side,
            operation:a.side==='confirm'?'confirm':!a.output?'delete':a.input?'update':'create'})),this.current.plan.conflicts.length);
        for (const conflict of this.current.plan.conflicts) this.renderConflict(conflict);
        if (this.choices.size) resolutionToolbar(this.planBody,this.choices,this.direction);
        for (const degraded of this.current.plan.degraded) paragraph(this.planBody,t('project.sync.degraded',{path:degraded.path,attribute:degraded.attribute}));
        this.executeButton.dataset.unavailable=String(!this.valid);this.mergeButton.dataset.unavailable=String(!mergePaths(this.current).length);
    }
    private renderConflict(conflict: FileConflict): void {
        const card=document.createElement('section');card.className='project-sync__conflict';
        card.dataset.syncPath=conflict.path;
        const label=document.createElement('label');label.textContent=`${conflict.path} · ${conflictReason(conflict.code)} `;
        const select=conflictSelect(conflict,this.direction);label.append(select);card.append(label);this.choices.set(conflict.path,select);
        const labels: [string,string]=[t('project.sync.localVersion'),t('project.sync.remoteVersion')];
        conflictMetadata(card,labels,[conflict.local,conflict.remote]);
        if (typeof this.service.compare==='function') this.compareButton(card,conflict.path,labels);
        this.planBody.append(card);
    }
    private compareButton(card: HTMLElement,path: string,labels: [string,string]): void {
        const button=document.createElement('button');button.type='button';button.textContent=t('project.sync.compareContent');
        const output=document.createElement('div');card.append(button,output);
        button.onclick=()=> { const id=this.current.id;void this.dialog.run(async()=> {
            const result=await this.service.compare(this.projectId,id,path);
            if (this.current.id===id && card.isConnected && !this.signal.aborted) renderComparison(output,result.baseline,result.local,result.remote,labels);
        }); };
    }
}
function mergePaths(stored: StoredFilePlan): string[] {
    return stored.plan.conflicts.filter(c=>c.baseline?.kind==='file' && c.local?.kind==='file' && c.remote?.kind==='file').map(c=>c.path);
}
function conflictSelect(conflict: FileConflict,direction: SyncDirection): HTMLSelectElement {
    const select=document.createElement('select');select.setAttribute('aria-label',conflict.path);
    for (const value of ['', 'local','remote'] as const) {
        const option=document.createElement('option');option.value=value;option.textContent=t(`project.sync.${value || 'unresolved'}`);
        option.disabled=(value==='local' && direction==='download') || (value==='remote' && direction==='upload');select.append(option);
    }
    select.dataset.unavailable=String(conflict.code!=='CONTENT_CONFLICT' || [conflict.baseline,conflict.local,conflict.remote].some(e=>e?.kind==='directory'));
    select.disabled=select.dataset.unavailable==='true';return select;
}
