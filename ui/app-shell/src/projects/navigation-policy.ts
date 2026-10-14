import { getLocale, t } from '@itookit/common';
import { resolveBrowserTarget, folderPathFromBrowserPath } from '@itookit/app-contracts';
import type { VFSNodeUI } from '@itookit/vfs-ui';

export function fileFirst(a: VFSNodeUI, b: VFSNodeUI): number | undefined {
    const favorites = (item: VFSNodeUI) => resolveBrowserTarget(item.id).kind === 'favorites';
    if (favorites(a) !== favorites(b)) return favorites(a) ? -1 : 1;
    const files = (item: VFSNodeUI) => resolveBrowserTarget(item.id).kind === 'project-files';
    if (files(a) !== files(b)) return files(a) ? -1 : 1;
    const session = (item: VFSNodeUI) => { const target = resolveBrowserTarget(item.id); return target.kind === 'session' || target.kind === 'remote' && !!target.nativeSessionId; };
    if (session(a) && session(b)) return ((Date.parse(b.metadata.lastModified) || 0) - (Date.parse(a.metadata.lastModified) || 0)) || a.id.localeCompare(b.id);
    return undefined;
}
function remoteItem(item: VFSNodeUI): VFSNodeUI {
    const known = (value: string) => Date.parse(value) > 0 ? value : '';
    const createdAt = known(item.metadata.createdAt), lastModified = known(item.metadata.lastModified);
    const subtitle = [[t('workbench.modified'), lastModified], [t('workbench.created'), createdAt]]
        .filter(([, time]) => time).map(([label, time]) => `${label}: ${new Date(time!).toLocaleString(getLocale())}`).join(' · ');
    return {...item, presentation: {...item.presentation, subtitle}, metadata: {...item.metadata, createdAt, lastModified}};
}
export function projectItems(items: VFSNodeUI[], query = '', family?: string): VFSNodeUI[] {
    return items.flatMap(item => {
        const kind = resolveBrowserTarget(item.id).kind;
        if (kind === 'session') {
            if (!query.trim() && family !== item.metadata.custom.familyRoot && item.metadata.custom.familyRoot && item.metadata.custom.familyRoot !== item.id.split('/').pop()) return [];
            const count = item.metadata.custom.familyRoot === item.id.split('/').pop() ? Number(item.metadata.custom.familyCount ?? 1) - 1 : 0;
            return [{ ...item, presentation: { ...item.presentation, quickDelete: true }, children: undefined, metadata: { ...item.metadata,
                title: item.metadata.title + (count ? ` (${count})` : ''),
                custom: { ...item.metadata.custom, navigationDescription: (query.trim() || family) && item.metadata.custom.parentTitle
                    ? t('project.parentSession', { name: String(item.metadata.custom.parentTitle) }) : '' } } }];
        }
        if (kind === 'favorite') return [{ ...item, children: undefined }];
        if (kind === 'favorites') return [item];
        if (kind === 'remote') return [{...remoteItem(item), children: item.children && projectItems(item.children, query, family).sort((a, b) => fileFirst(a, b) ?? 0)}];
        if (kind === 'project-files') return [{ ...item, children: item.children && projectItems(item.children, query, family) }];
        if (kind !== 'folder') return [];
        if (folderPathFromBrowserPath(item.id)?.endsWith('/@sessions')) return projectItems(item.children ?? [], query, family);
        return [{ ...item, children: item.children && projectItems(item.children, query, family) }];
    });
}
