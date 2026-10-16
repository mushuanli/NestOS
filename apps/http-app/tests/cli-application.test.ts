import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost, createCertificates, loadCertificates } from '@itookit/node-host/http';
import { ProjectRemoteMountService } from '@itookit/app-core';
import { openCliApplication } from '../../cli/src/application-host';
import { executeApplicationCommand } from '../../cli/src/application-command';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'mindos-cli-http-')); cleanup.push(() => rm(root, {recursive: true, force: true}));
    const identity = path.join(root, 'certs'); await createCertificates(identity, ['127.0.0.1']);
    const local = {profile: path.join(root, 'data'), authDir: path.join(root, 'auth'), auditFile: path.join(root, 'cli-local-audit.jsonl')};
    const start = async () => {
        const host = await startHost({root: local.profile, sidecar: path.join(local.profile, '_meta'), authDir: local.authDir,
            auditFile: path.join(root, 'httpd-test-audit.jsonl'), certificates: await loadCertificates(identity), staticDir: root, port: 0, host: '127.0.0.1', backlog: 32});
        cleanup.push(() => host.close());
        const port = (host.server.address() as {port: number}).port;
        return {connect: `https://127.0.0.1:${port}`, clientCert: path.join(identity, 'client.crt'), clientKey: path.join(identity, 'client.key'), caCert: path.join(identity, 'ca.crt')};
    };
    return {local, start};
}
it('reads and updates identical persisted application models over direct API and authenticated HTTP', async () => {
    const {local, start} = await setup(), direct = await openCliApplication(local);
    const project = await executeApplicationCommand(direct.client, 'project', ['create', 'Shared project'], local) as {project: {id: string}};
    const id = await executeApplicationCommand(direct.client, 'session', ['create', project.project.id, 'Shared session'], local) as string;
    const before = await executeApplicationCommand(direct.client, 'session', ['show', id], local) as {sessionId: string};
    await direct.close();
    const options = await start(), remote = await openCliApplication(options); cleanup.push(() => remote.close());
    const after = await executeApplicationCommand(remote.client, 'session', ['show', id], options) as {sessionId: string};
    expect(after.sessionId).toBe(before.sessionId);
    expect(await remote.client.services.projects.sessions.get(id)).toMatchObject({id, title: 'Shared session'});
    await remote.client.services.projects.sessions.rename(id, 'Renamed over HTTP');
    expect((await remote.client.services.sessionRepository.getManifest(id)).title).toBe('Renamed over HTTP');
});
it.each(['not-committed', 'unknown'] as const)('diagnoses a native send %s through the same remote conversation port without UI or retry', async outcome => {
    const state = {sessionId: 'native', title: 'Native', messages: [], requests: [], canSend: true, canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false};
    const failure = Object.assign(new Error('Native writer conflict'), {code: 'HARNESS_SESSION_BUSY', outcome, requestId: 'fixture-request'});
    const controls = {kind: 'codex', snapshot: () => state, read: vi.fn(async () => state), respond: vi.fn(), close: vi.fn(async () => {}),
        send: vi.fn(async () => {state.pending = outcome === 'unknown'; throw failure;})};
    const conversation = vi.spyOn(ProjectRemoteMountService.prototype, 'projectConversation').mockResolvedValue(controls as never);
    const {local, start} = await setup(); const initial = await openCliApplication(local); await initial.close();
    const options = await start(), client = await openCliApplication(options); cleanup.push(() => client.close());
    await expect(executeApplicationCommand(client.client, 'conversation', ['send', 'project', 'codex', 'native', 'fixture prompt'], options))
        .rejects.toMatchObject({code: 'HARNESS_SESSION_BUSY', outcome, requestId: 'fixture-request'});
    expect(conversation).toHaveBeenCalledOnce(); expect(controls.read).toHaveBeenCalledOnce();
    expect(controls.send).toHaveBeenCalledExactlyOnceWith('fixture prompt'); expect(controls.close).toHaveBeenCalledOnce();
});
