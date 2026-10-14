import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { WorkbenchArchiveExporter, parseWorkbenchArchive } from '../src/projects/workbench-archive';
import { WorkbenchArchiveImporter } from '../src/projects/workbench-import';
import { SessionLifecycleService } from '../src/session/session-lifecycle';
import type { ProjectTarget } from '../src/projects/targets';

let runtime: ApplicationRuntime;
afterEach(async () => { vi.restoreAllMocks(); await runtime?.dispose(); });
async function setup() {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const { projects, sessionRepository: repository } = runtime;
    const project = (await projects.current())!, folder = await projects.sessionFolder(project);
    const parent = await repository.createSession('Parent', folder), child = await repository.createSession('Child', folder, parent);
    await repository.writeDocument(parent, 'draft.json', JSON.stringify({ text: 'unfinished' }));
    await repository.saveSessionSettings(child, { historyLength: 9 });
    await repository.writeDocument(child, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    await repository.updateManifest(child, { rootRoundId: 'r1', currentHead: 'r1', branches: { main: 'r1' }, uiState: { scrollPosition: 23 } });
    const attachments = await repository.openAttachments(child);
    await attachments.driver.createDirectory({ parentPath: '/', name: 'nested' });
    await attachments.driver.createFile({ parentPath: '/nested', name: 'data.bin', content: new Uint8Array([0, 255, 128]).buffer });
    await attachments.dispose();
    const files = await projects.openFiles(project.path);
    await files.fs.driver.createDirectory({ parentPath: '/', name: '.hidden' });
    await files.fs.driver.createFile({ parentPath: '/.hidden', name: 'notes.md', content: 'project notes', icon: 'custom' });
    await files.fs.meta.assets.putAsset('/.hidden/notes.md', 'image.bin', new Uint8Array([0, 255]).buffer);
    await files.fs.driver.createFile({ parentPath: '/', name: 'journal.seq', type: 'seqfile' });
    await files.fs.meta.seq!.setEntry('/journal.seq', 'event/first', 'record content');
    await files.dispose();
    const exporter = new WorkbenchArchiveExporter(projects, repository);
    const importer = new WorkbenchArchiveImporter(projects, new SessionLifecycleService({ repository, kernel: runtime.kernel.kernel }), repository);
    return { projects, repository, project, folder, parent, child, exporter, importer };
}
it('round-trips project files, nested attachments, drafts, settings and independent child Sessions', async () => {
    const r = await setup(), archive = await r.exporter.export([{ kind: 'project', projectId: r.project.project.id }]);
    const [copy] = await r.importer.import(JSON.stringify(archive), { kind: 'project', projectId: r.project.project.id });
    const exported = await new WorkbenchArchiveExporter(r.projects, r.repository).export([copy!]);
    // Storage folders change with the imported project name; content and hierarchy remain equal.
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => ['folder', 'updatedAt'].includes(key) ? undefined : item));
    expect(normalize(exported.items[0])).toEqual(normalize({ ...archive.items[0], name: r.project.name + ' (2)' }));
    const sessions = (await r.repository.list()).filter(item => item.folder !== r.folder);
    expect(sessions).toHaveLength(2);
    const parent = sessions.find(item => item.title === 'Parent')!, child = sessions.find(item => item.title === 'Child')!;
    expect(child.parentSessionId).toBe(parent.id); expect(child.id).not.toBe(r.child);
    expect((await r.repository.getSessionSettings(child.id)).historyLength).toBe(9);
    expect(await r.repository.readDocument(parent.id, 'draft.json')).toContain('unfinished');
    const again = await r.importer.import(JSON.stringify(archive), copy!);
    expect(again[0]).not.toBe(copy); expect(await r.projects.list()).toHaveLength(3);
});
it('deduplicates selected Session families and restores them into the selected project', async () => {
    const r = await setup(), other = await r.projects.create('Other');
    const archive = await r.exporter.export([{ kind: 'session', sessionId: r.parent }, { kind: 'session', sessionId: r.child }]);
    expect(archive.items).toHaveLength(1);
    const [path] = await r.importer.import(JSON.stringify(archive), { kind: 'project', projectId: other.project.id });
    const parent = await r.repository.getManifest(path!.kind === 'session' ? path!.sessionId : '');
    expect(parent.folder).toBe(other.path + '/@sessions');
    expect((await r.repository.list()).find(item => item.parentSessionId === parent.id)?.title).toBe('Child');
});
it('copies selected files without overwriting and includes their assets', async () => {
    const r = await setup(), path: ProjectTarget = { kind: 'file', projectId: r.project.project.id, path: '/.hidden/notes.md' };
    const archive = await r.exporter.export([path]), [copy] = await r.importer.import(JSON.stringify(archive), path);
    expect(copy).toEqual({ ...path, path: '/.hidden/notes (2).md' });
    const files = await r.projects.openFiles(r.project.path);
    expect(await files.fs.driver.readContent('/.hidden/notes.md', { encoding: 'utf-8' })).toBe('project notes');
    expect(new Uint8Array(await files.fs.meta.assets.getAsset('/.hidden/notes (2).md', 'image.bin') as ArrayBuffer)).toEqual(new Uint8Array([0, 255]));
    await files.dispose();
});
it('validates all items before writing and rolls back a later Session failure', async () => {
    const r = await setup(), archive = await r.exporter.export([{ kind: 'project', projectId: r.project.project.id }]), before = await r.projects.list();
    const malformed = structuredClone(archive);
    if (malformed.items[0]?.kind === 'project') malformed.items[0].files.push({ path: '../escape', type: 'file', base64: '' });
    expect(() => parseWorkbenchArchive(JSON.stringify(malformed))).toThrow();
    expect(await r.projects.list()).toEqual(before);
    const write = r.repository.writeDocument.bind(r.repository);
    vi.spyOn(r.repository, 'writeDocument').mockImplementation(async (id, name, text) => {
        if (name.startsWith('round-')) throw new Error('injected write failure');
        return write(id, name, text);
    });
    await expect(r.importer.import(JSON.stringify(archive), { kind: 'group', folder: null })).rejects.toThrow('injected write failure');
    expect(await r.projects.list()).toEqual(before);
    expect((await r.repository.list()).map(item => item.id).sort()).toEqual([r.parent, r.child].sort());
});
