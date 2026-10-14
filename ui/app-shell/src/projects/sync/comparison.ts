import { t } from '@itookit/common';
import type { ProjectSyncContent } from '@itookit/app-contracts/services';
import { paragraph } from './dialog';

export function conflictMetadata(parent: HTMLElement, labels: [string,string], values: Array<{kind: string; hash?: string | null; size?: string | number} | null | undefined>): void {
    for (let i=0; i<2; i++) {
        const value=values[i];
        paragraph(parent, `${labels[i]}: ${value ? value.kind==='directory' ? t('project.sync.content.directory') : t('project.sync.content.file') : t('project.sync.content.missing')}`
            + (value?.size!==undefined ? ` · ${value.size} B` : '') + (value?.hash ? ` · SHA-256 ${value.hash.slice(0,12)}` : ''));
    }
}
export function renderComparison(parent: HTMLElement, baseline: ProjectSyncContent, left: ProjectSyncContent, right: ProjectSyncContent, labels: [string,string]): void {
    parent.replaceChildren();
    const columns=document.createElement('div'); columns.className='project-sync__comparison';
    const differences=changedLines(left.content?.text, right.content?.text);
    contentPane(columns, labels[0], left, differences?.[0]); contentPane(columns, labels[1], right, differences?.[1]); parent.append(columns);
    const details=document.createElement('details'), summary=document.createElement('summary');summary.textContent=t('project.sync.baseline');details.append(summary);
    contentPane(details,t('project.sync.baseline'),baseline);parent.append(details);
}
function contentPane(parent: HTMLElement, label: string, value: ProjectSyncContent, changed?: Set<number>): void {
    const pane=document.createElement('section'), heading=document.createElement('h4'); heading.textContent=label;pane.append(heading);
    if (value.hash) paragraph(pane, `SHA-256: ${value.hash}`);
    if (value.size!==undefined) paragraph(pane, `${value.size} B`);
    if (value.content?.text!==undefined) {
        const pre=document.createElement('pre');pre.className='project-sync__text';
        if (changed) value.content.text.split('\n').forEach((line,index) => {
            const span=document.createElement('span');span.textContent=`${index+1}  ${line}\n`;span.className='project-sync__line';
            if (changed.has(index)) span.classList.add('project-sync__line--changed');pre.append(span);
        });
        else pre.textContent=value.content.text;
        pane.append(pre);
    } else paragraph(pane,t(value.kind==='missing'?'project.sync.content.missing':value.kind==='directory'?'project.sync.content.directory'
        :value.content?.reason==='binary'?'project.sync.content.binary':value.content?.reason==='too-large'?'project.sync.content.tooLarge':'project.sync.content.unavailable'));
    parent.append(pane);
}
/** LCS marks insertions/deletions; large comparisons retain the full plain text. */
function changedLines(left: string | undefined, right: string | undefined): [Set<number>,Set<number>] | undefined {
    if (left===undefined || right===undefined) return;
    const a=left.split('\n'), b=right.split('\n'); if (a.length*b.length>250000 || a.length+b.length>2000) return;
    const width=b.length+1, cells=new Uint16Array((a.length+1)*width);
    for (let i=a.length-1;i>=0;i--) for (let j=b.length-1;j>=0;j--)
        cells[i*width+j]=a[i]===b[j]?1+cells[(i+1)*width+j+1]:Math.max(cells[(i+1)*width+j],cells[i*width+j+1]);
    const x=new Set<number>(), y=new Set<number>();let i=0,j=0;
    while (i<a.length || j<b.length) {
        if (i<a.length && j<b.length && a[i]===b[j]) {i++;j++;}
        else if (j===b.length || (i<a.length && cells[(i+1)*width+j]>=cells[i*width+j+1])) x.add(i++);
        else y.add(j++);
    }
    return [x,y];
}
