import { createDirectoryBreadcrumbs as createBreadcrumbs, type DirectoryBreadcrumb } from '@itookit/vfs-ui';
import { directoryPresentation } from './directory-presentation';
export type { DirectoryBreadcrumb } from '@itookit/vfs-ui';

export function createDirectoryBreadcrumbs(items: DirectoryBreadcrumb[], open: (id: string) => void): HTMLElement {
    return createBreadcrumbs(items, open, directoryPresentation());
}

export function fileDirectoryBreadcrumbs(path: string, root: string): DirectoryBreadcrumb[] {
    const result = [{ id: '/', label: root }];
    let id = '';
    for (const label of path.split('/').filter(Boolean)) { id += '/' + label; result.push({ id, label }); }
    return result;
}
