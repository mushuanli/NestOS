import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'node:net';
import { openCliApplication } from '../src/application-host';
import { executeApplicationCommand } from '../src/application-command';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function options() {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-app-cli-')); roots.push(root);
    return {profile: path.join(root, 'data'), authDir: path.join(root, 'auth'), auditFile: path.join(root, 'cli-local-audit.jsonl')};
}
it('uses the same persistent Project and Session models without opening a listener, and fences a second local host', async () => {
    const config = await options(), listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(() => {throw new Error('Local CLI must not listen');});
    let application = await openCliApplication(config);
    try {
        const project = await executeApplicationCommand(application.client, 'project', ['create', 'CLI project'], config) as {project: {id: string}};
        const id = await executeApplicationCommand(application.client, 'session', ['create', project.project.id, 'CLI session'], config) as string;
        const snapshot = await executeApplicationCommand(application.client, 'session', ['show', id], config) as {sessionId: string};
        expect(snapshot.sessionId).toBe(id); expect(listen).not.toHaveBeenCalled();
        await expect(openCliApplication(config)).rejects.toThrow('another application host');
        await application.close(); application = await openCliApplication(config);
        const sessions = await executeApplicationCommand(application.client, 'session', ['list'], config) as Array<{id: string}>;
        expect(sessions.some(session => session.id === id)).toBe(true);
        expect((await readdir(config.profile)).includes('_meta')).toBe(true);
    } finally { await application.close(); }
    expect(await readFile(config.auditFile, 'utf8')).not.toContain('CLI session');
});
it('never opens a local profile when explicit remote identity is missing or malformed', async () => {
    await expect(openCliApplication({connect: 'http://localhost:2000'})).rejects.toThrow('HTTPS');
    await expect(openCliApplication({connect: 'https://localhost:2000'})).rejects.toThrow('--client-cert');
});

it('keeps the local CLI usable when a previously registered host directory disappears', async () => {
    const config = await options(), directory = path.join(config.profile, '..', 'external-project');
    await mkdir(directory);
    let app = await openCliApplication(config);
    try {
        await app.client.services.projects.create('External project', null, 'host:' + directory);
        await app.close(); await rm(directory, {recursive: true});
        app = await openCliApplication(config);
        await expect(app.client.services.projects.list()).resolves.toEqual(expect.any(Array));
    } finally {await app.close();}
});

it('rejects private credentials inside the local data root before opening storage', async () => {
    const config = await options();
    await expect(openCliApplication({...config, authDir: path.join(config.profile, 'credentials')})).rejects.toThrow('outside the VFS');
});
