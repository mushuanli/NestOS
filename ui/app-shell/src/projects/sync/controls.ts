import { t } from '@itookit/common';
import { paragraph } from './dialog';
export type SyncDirection = 'both' | 'upload' | 'download';
export function directionSelect(parent: HTMLElement, value: SyncDirection, directory = false): HTMLSelectElement {
    const label = document.createElement('label'); label.className = 'project-sync__field'; label.textContent = t('project.sync.direction');
    const select = document.createElement('select'); select.setAttribute('aria-label', t('project.sync.direction'));
    for (const direction of ['both','upload','download'] as const) {
        const option = document.createElement('option'); option.value = direction;
        option.textContent = directory ? t(`project.sync.directoryDirection.${direction}`) : t(`project.sync.directionLabel.${direction}`);
        select.append(option);
    }
    select.value = value; label.append(select); parent.append(label);
    paragraph(parent, t(directory ? 'project.sync.directoryPolicy' : 'project.sync.updatePolicy'));
    return select;
}
export function conflictReason(code: string): string {
    const known = ['CONTENT_CONFLICT','TYPE_CONFLICT','UNKNOWN_LOCAL','UNSUPPORTED_LOCAL','SYNC_FILE_LIMIT','SYNC_CONTROL_PATH',
        'SYNC_MOUNT_PATH','UNSUPPORTED_NODE','NON_UTF8_NAME','LOCAL_OBJECT_MISSING','TARGET_CHANGED','UNSUPPORTED','ECAPABILITY',
        'DIRECTORY_GROUP_BLOCKED','DELETE_REQUIRES_POLICY','SCAN_INCOMPLETE'];
    return known.includes(code) ? t(`project.sync.reason.${code}` as Parameters<typeof t>[0]) : t('project.sync.reason.other', { code });
}
export interface ChangeRow { path: string; side: string; operation: 'create' | 'update' | 'delete' | 'confirm' }
export function renderChanges(parent: HTMLElement, rows: ChangeRow[], conflicts: number, directory = false): void {
    paragraph(parent, t('project.sync.summary', { total: rows.length, upload: rows.filter(r=>r.side==='upload').length,
        download: rows.filter(r=>r.side==='download').length, deleted: rows.filter(r=>r.operation==='delete').length, conflicts }));
    const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = t('project.sync.searchPaths');
    filter.setAttribute('aria-label', t('project.sync.searchPaths'));
    const table = document.createElement('table'); table.className = 'project-sync__changes';
    const head = table.createTHead().insertRow();
    for (const key of ['path','operation','destination'] as const) { const cell = document.createElement('th'); cell.textContent = t(`project.sync.column.${key}`); head.append(cell); }
    const body = table.createTBody();
    for (const item of rows) {
        const row = body.insertRow(); row.dataset.syncPath = item.path;
        row.insertCell().textContent = item.path; row.insertCell().textContent = t(`project.sync.operation.${item.operation}`);
        row.insertCell().textContent = directory ? t(`project.sync.directoryDestination.${item.side==='upload'?'upload':'download'}`)
            : t(`project.sync.destination.${item.side==='upload'?'upload':item.side==='confirm'?'confirm':'download'}`);
    }
    filter.oninput = () => { for (const row of parent.querySelectorAll<HTMLElement>('[data-sync-path]')) row.hidden = !row.dataset.syncPath!.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()); };
    parent.append(filter,table);
    if (!rows.length && !conflicts) paragraph(parent, t('project.sync.noChanges'));
}
export function resolutionToolbar(parent: HTMLElement,choices: Map<string,HTMLSelectElement>,direction: SyncDirection,
    directory = false,changed: () => void = () => {}): void {
    const toolbar=document.createElement('div');toolbar.className='project-sync__resolutions';
    const sides=directory?['directory','dataset']:['local','remote'];
    for (const [index,value] of sides.entries()) {
        const button=document.createElement('button');button.type='button';
        button.textContent=t(index===0?(directory?'project.sync.selectAllDirectory':'project.sync.selectAllLocal'):(directory?'project.sync.selectAllDataset':'project.sync.selectAllRemote'));
        button.dataset.unavailable=String(index===0?direction==='download':direction==='upload');button.disabled=button.dataset.unavailable==='true';
        button.onclick=()=> {for (const select of choices.values()) if (!select.disabled && [...select.options].some(o=>o.value===value && !o.disabled)) select.value=value;changed();};
        toolbar.append(button);
    }
    paragraph(toolbar,t('project.sync.selectSourceHint'));parent.append(toolbar);
}
