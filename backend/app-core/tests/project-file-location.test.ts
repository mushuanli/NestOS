import { expect, it } from 'vitest';
import { projectFileLocation } from '../src/projects/file-location';
import type { ProjectFolder } from '../src/projects/project-service';
import type { ProjectRemoteMount } from '../src/projects/remote-mounts';

const project: ProjectFolder = { path: '/Project', name: 'Project', project: { id: 'project', directory: '~/shared' } };
const grant: ProjectRemoteMount = { mountId: 'root', at: '/', root: '/team', access: 'rw',
    endpoint: 'https://files.test', alias: 'docs', credentialRef: 'secret-reference', username: 'alice' };

it('resolves the longest remote grant and respects path segment boundaries', () => {
    const nested = { ...grant, mountId: 'nested', at: '/reference', root: '/library' };
    expect(projectFileLocation(project, '/reference/note.md', [grant, nested]).path).toBe('/library/note.md');
    expect(projectFileLocation(project, '/reference-other/note.md', [grant, nested]).path).toBe('/team/reference-other/note.md');
    expect(projectFileLocation(project, '/reference', [nested]).path).toBe('/library');
    expect(projectFileLocation(project, '/note.md', []).path).toBe('/home/admin/shared/note.md');
});

it('compares the same remote namespace across grants without conflating servers or aliases', () => {
    const a = projectFileLocation(project, '/note.md', [grant]);
    const b = projectFileLocation(project, '/team/note.md', [{ ...grant, root: '/', credentialRef: 'another-reference' }]);
    expect(a).toEqual(b);
    for (const change of [{ alias: 'other' }, { endpoint: 'https://other.test' }, { username: 'bob' }]) {
        expect(projectFileLocation(project, '/note.md', [{ ...grant, ...change }]).namespace).not.toBe(a.namespace);
    }
});

it('distinguishes managed and host sources and accepts Windows host paths', () => {
    const local = projectFileLocation(project, '/note.md', []);
    const host = projectFileLocation({ ...project, project: { ...project.project, directory: 'host:/home/admin/shared' } }, '/note.md', []);
    expect(local.path).toBe(host.path);
    expect(local.namespace).not.toBe(host.namespace);
    expect(projectFileLocation({ ...project, project: { ...project.project, directory: 'host:C:\\Projects\\docs' } }, '/note.md', []).path)
        .toBe('C:/Projects/docs/note.md');
});
