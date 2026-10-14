import { afterEach, expect, it, vi } from 'vitest';
import { createApplicationRuntime, ProjectService, type ApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { createFileChatHandler } from '../src/projects/file-chat';

let runtime: ApplicationRuntime | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('persists a quote draft in the owning project before navigating, including session-owned files', async () => {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const { projects, sessionRepository: repository } = runtime;
    const research = await projects.create('Research');
    const navigate = vi.fn(async request => {
        expect((await repository.getUIState(request.resourceId))?.branchDrafts?.main?.inputText).toContain('````\n```text\nquoted\n```\n````');
    });
    const chat = createFileChatHandler(projects, repository, navigate);
    const reference = { path: '/notes.md', content: '```text\nquoted\n```', selection: true };
    await chat(reference, { projectFolder: research.path });
    const first = navigate.mock.calls[0][0].resourceId;
    expect((await repository.getManifest(first)).folder).toBe(research.path + '/@sessions');
    await chat(reference, { sessionId: first });
    expect((await repository.getManifest(navigate.mock.calls[1][0].resourceId)).folder).toBe(research.path + '/@sessions');
    expect(navigate.mock.calls[0][0]).toEqual({ target: 'chat', resourceId: first });
});

it('uses the personal project for unassociated files even when another project is current', async () => {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const { projects, sessionRepository: repository } = runtime;
    const personal = await projects.personal();
    await projects.renameProject(personal.path, '/Renamed personal');
    const other = await projects.create('AAA work');
    await projects.ensureStartup(other.project.directory);
    expect((await projects.current())!.project.id).toBe(other.project.id);
    const navigate = vi.fn(async () => {});
    const chat = createFileChatHandler(projects, repository, navigate);
    await chat({ path: '/unrelated.md', content: 'entire file', selection: false });
    const sessions = await repository.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].folder).toBe('/Renamed personal/@sessions');
    const reopened = new ProjectService(await runtime.vfs.openFileSystem('/'), repository, runtime.directoryMounts, runtime.sessionFiles);
    expect((await reopened.personal()).project.id).toBe(personal.project.id);
    expect((await repository.getUIState(sessions[0].id))?.branchDrafts?.main?.inputText).toContain('entire file');
});

it('does not redirect a deleted source project into the personal project', async () => {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const navigate = vi.fn(async () => {});
    const chat = createFileChatHandler(runtime.projects, runtime.sessionRepository, navigate);
    await expect(chat({ path: '/note.md', content: 'body', selection: false },
        { projectFolder: '/deleted' })).rejects.toThrow('Source project no longer exists');
    expect(await runtime.sessionRepository.list()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
});
