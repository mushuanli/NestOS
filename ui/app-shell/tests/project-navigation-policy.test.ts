import {expect, it} from 'vitest';
import type {VFSNodeUI} from '@itookit/vfs-ui';
import {resolveBrowserTarget} from '@itookit/app-contracts';
import {fileFirst, navigationPriority, projectItems} from '../src/projects/navigation-policy';

const item = (id: string) => ({id, metadata: {title: id, createdAt: '', lastModified: '', custom: {}}}) as VFSNodeUI;
it('keeps the local draft after favorites/files and before real sessions', () => {
    const root = '/folder:Project', ids = [root + '/session', root + '/@new', root + '/@files', root + '/@favorites'];
    expect(projectItems(ids.map(item)).sort((a, b) => fileFirst(a, b) ?? 0).map(node => node.id))
        .toEqual([root + '/@favorites', root + '/@files', root + '/@new', root + '/session']);
    expect(resolveBrowserTarget(root + '/@new')).toEqual({kind: 'project-draft', folder: '/Project'});
    expect(() => resolveBrowserTarget('/@new')).toThrow();
    expect(() => resolveBrowserTarget(root + '/@new/child')).toThrow();
});
it('keeps each remote draft first and archived/pagination entries after real sessions', () => {
    const root = '/folder:Project/@harness/native', ids = [root + '/@archived', root + '/session', root + '/@new'];
    expect([...ids].sort((a, b) => navigationPriority(a) - navigationPriority(b)))
        .toEqual([root + '/@new', root + '/session', root + '/@archived']);
});
