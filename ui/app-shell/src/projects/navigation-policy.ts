import { ACTION_ICONS, FILE_ICONS, getLocale, t } from '@itookit/common';
import { resolveBrowserTarget, WORKSPACE_PATH } from '@itookit/app-contracts';
import type { VFSNodeUI } from '@itookit/vfs-ui';

/** Fixed project entries keep their order independently of user sort direction. */
export function navigationPriority(path: string): number {
    const target = resolveBrowserTarget(path);
    if (target.kind === 'favorites') return -30;
    if (target.kind === 'project-conversations') return 20;
    if (target.kind === 'project-files' && target.path === WORKSPACE_PATH) return -20;
    if (target.kind === 'project-draft' || target.kind === 'remote' && (target.draft || !target.profileId)) return -10;
    if (target.kind === 'remote' && (target.cursor || target.archived)) return 10;
    return 0;
}
export function fileFirst(a: VFSNodeUI, b: VFSNodeUI): number | undefined {
    const defaultOrder = Number(b.metadata.custom.defaultProject === true) - Number(a.metadata.custom.defaultProject === true);
    if (defaultOrder) return defaultOrder;
    const priority = navigationPriority(a.id) - navigationPriority(b.id);
    if (priority) return priority;
    const session = (item: VFSNodeUI) => { const target = resolveBrowserTarget(item.id); return target.kind === 'session' || target.kind === 'remote' && !!target.nativeSessionId; };
    if (session(a) && session(b)) return ((Date.parse(b.metadata.lastModified) || 0) - (Date.parse(a.metadata.lastModified) || 0)) || a.id.localeCompare(b.id);
    return undefined;
}
function datedItem(item: VFSNodeUI): VFSNodeUI {
    const known = (value: string) => Date.parse(value) > 0 ? value : '';
    const createdAt = known(item.metadata.createdAt), lastModified = known(item.metadata.lastModified);
    const subtitle = [[t('workbench.modified'), lastModified], [t('workbench.created'), createdAt]]
        .filter(([, time]) => time).map(([label, time]) => `${label}: ${new Date(time!).toLocaleString(getLocale())}`).join(' · ');
    return {...item, presentation: {...item.presentation, subtitle}, metadata: {...item.metadata, createdAt, lastModified}};
}
export function projectItems(items: VFSNodeUI[], query = ''): VFSNodeUI[] {
    return items.flatMap(item => {
        if (item.metadata.custom.navigationHidden === true) return [];
        if (item.metadata.custom.navigationTransparent === true) return projectItems(item.children ?? [], query);
        const target = resolveBrowserTarget(item.id), kind = target.kind;
        if (kind === 'session') {
            const row = datedItem(item);
            return [{ ...row, kind: 'file', type: 'file', presentation: { ...row.presentation, quickDelete: true }, children: undefined, metadata: { ...row.metadata,
                custom: { ...row.metadata.custom, navigationDescription: item.metadata.custom.parentTitle
                    ? t('project.parentSession', { name: String(item.metadata.custom.parentTitle) }) : '' } } }];
        }
        if (kind === 'favorite') return [{ ...item, children: undefined }];
        if (kind === 'project-draft') return [{...item, children: undefined}];
        if (kind === 'project-conversations') return [{...datedItem(item), kind: 'file', type: 'file', children: undefined}];
        if (kind === 'favorites') return [navigationEntry(item, t('project.favorites'), ACTION_ICONS.favorite)];
        if (kind === 'remote') return [{...datedItem(item), children: item.children && projectItems(item.children, query).sort((a, b) => fileFirst(a, b) ?? 0)}];
        if (target.kind === 'project-files') {
            const entry = target.path === WORKSPACE_PATH ? navigationEntry(item, t('project.files'), FILE_ICONS.folder) : item;
            return [{ ...entry, children: item.children && projectItems(item.children, query) }];
        }
        if (kind !== 'folder') return [];
        return [{ ...item, children: item.children && projectItems(item.children, query) }];
    });
}

function navigationEntry(item: VFSNodeUI, title: string, icon: string): VFSNodeUI {
    return { ...item, icon, presentation: { ...item.presentation, fileDetails: false }, metadata: { ...item.metadata, title } };
}
