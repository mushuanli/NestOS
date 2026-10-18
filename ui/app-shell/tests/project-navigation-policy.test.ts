import {expect, it} from 'vitest';
import type {VFSNodeUI} from '@itookit/vfs-ui';
import {resolveBrowserTarget} from '@itookit/app-contracts';
import {fileFirst, navigationPriority, projectItems} from '../src/projects/navigation-policy';
import { ACTION_ICONS, FILE_ICONS, t } from '@itookit/common';

const item = (id: string) => ({id, metadata: {title: id, createdAt: '', lastModified: '', custom: {}}}) as VFSNodeUI;

it('labels fixed entries with localized names and icons while preserving routes and literal file names', () => {
    const root = '/folder:Project', favorites = item(root + '/@favorites'), files = item(root + '/@files');
    const literal = item(files.id + '/@favorites'); literal.metadata.title = '@favorites';
    files.children = [literal]; files.presentation = { fileDetails: true };
    const rows = projectItems([favorites, files]);
    expect(rows.map(row => row.id)).toEqual([favorites.id, files.id]);
    expect(rows.map(row => row.metadata.title)).toEqual([t('project.favorites'), t('project.files')]);
    expect(rows.map(row => row.icon)).toEqual([ACTION_ICONS.favorite, FILE_ICONS.folder]);
    expect(rows.every(row => row.presentation?.fileDetails === false)).toBe(true);
    expect(rows[1].children![0].metadata.title).toBe('@favorites');
    expect(files.metadata.title).toBe(files.id);
});

it('removes the transparent remote container but keeps executor groups and unavailable feedback', () => {
    const group = item('/folder:Project/@harness'), codex = item(group.id + '/codex'), claude = item(group.id + '/claude');
    group.metadata.custom.navigationTransparent = true; group.children = [codex, claude];
    expect(projectItems([group]).map(row => row.id)).toEqual([codex.id, claude.id]);
    const unavailable = item(group.id + '/unavailable'); unavailable.metadata.custom._disabled = true;
    group.children = [unavailable];
    expect(projectItems([group])[0].metadata.custom._disabled).toBe(true);
});
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

it('shows every related local conversation directly with the same timestamps as native conversations', () => {
    const root = '/folder:Project', createdAt = '2026-10-01T10:00:00.000Z', lastModified = '2026-10-17T10:00:00.000Z';
    const parent = item(root + '/parent'), child = item(root + '/child'), native = item(root + '/@harness/native/remote');
    parent.metadata.title = 'Parent'; child.metadata.title = 'Child';
    parent.metadata.custom = {familyRoot: 'parent', familyCount: 2};
    child.metadata.custom = {familyRoot: 'parent', parentTitle: 'Parent'};
    for (const node of [parent, child, native]) Object.assign(node.metadata, {createdAt, lastModified});
    const rows = projectItems([parent, child, native]);
    expect(rows.map(row => row.id)).toEqual([parent.id, child.id, native.id]);
    expect(rows[0].metadata.title).toBe('Parent');
    expect(rows[1].metadata.custom.navigationDescription).toContain('Parent');
    expect(rows[1].presentation?.subtitle).toBe(rows[2].presentation?.subtitle);
    expect(rows[1].presentation?.subtitle).toContain('2026');
    expect(projectItems([child], 'Child')).toHaveLength(1);
});

it('flattens backend-declared transparent groups without interpreting their directory name', () => {
    const group = item('/folder:Project/folder:opaque'), child = item(group.id + '/session');
    group.metadata.custom.navigationTransparent = true; group.children = [child];
    expect(projectItems([group]).map(row => row.id)).toEqual([child.id]);
    const ordinary = item('/folder:Project/folder:%40sessions'); ordinary.children = [child];
    expect(projectItems([ordinary]).map(row => row.id)).toEqual([ordinary.id]);
});
