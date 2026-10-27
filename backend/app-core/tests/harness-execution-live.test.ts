import { readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager } from '@itookit/vfs-core';
import { createNestOSNodeDriver, type NestOSNodeDriver, type RemoteProject } from '@itookit/nestos-node-driver';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import type { HarnessConnectionSnapshot, HarnessExecutionRequest } from '@itookit/kernel-adapters/contracts';
import { HarnessConnectionService } from '../src/projects/harness-connections';
import { createHarnessExecutionProvider, harnessExecutionJournalKey } from '../src/projects/harness-execution';
import type { ProjectRemoteMount } from '../src/projects/remote-mounts';
import { durableState } from './harness-execution-fixture';
import { diskState } from './harness-execution-disk-fixture';

const metadataFile = process.env.NESTOS_HARNESS_LIVE_METADATA;
const testRunId = randomUUID();
let manager: IVFSManager, driver: NestOSNodeDriver, service: HarnessConnectionService, snapshot: HarnessConnectionSnapshot;
let metadata: { endpoint: string; serverId: string; project: RemoteProject; profileId: string; credentialFile: string; root: string };

beforeAll(async () => {
    if (!metadataFile) return;
    metadata = JSON.parse(await readFile(resolve(metadataFile), 'utf8'));
    driver = createNestOSNodeDriver(); driver.setCredential('live-fixture', await readFile(metadata.credentialFile, 'utf8'));
    const config = { endpoint: metadata.endpoint, credentialRef: 'live-fixture' };
    const descriptor = await driver.discover({ ...config, endpoint: `${metadata.endpoint}/mcp` });
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const node = { ...config, id: 'live-node', name: 'Live node', serverId: descriptor.serverId, authorization: descriptor.authorization };
    const mount = { ...node, connectionId: node.id, mountId: 'root', at: '/', alias: 'root', root: metadata.project.path,
        access: 'rw', serverProjectId: metadata.project.id, serverProjectRevision: metadata.project.revision } as ProjectRemoteMount;
    service = new HarnessConnectionService(await manager.openFileSystem('/'), { list: () => [mount], resolveConnection: async () => node,
        projectHarness: async () => driver.projects(config).harness(metadata.project) });
    await service.save({ id: 'live-execution', name: 'Live native Claude', kind: 'harness', nodeConnectionId: node.id,
        projectId: 'live-project', profileId: metadata.profileId }, 0);
    snapshot = (await service.freeze('live-execution'))!;
}, 30_000);
afterAll(async () => { await driver?.dispose(); await manager?.dispose(); });

function invocation(id: string, prompt: string) {
    const storage = durableState(), controller = new AbortController();
    const context: EffectExecutionContext = { sessionId: `live-${testRunId}-${id}`, taskId: 'task', effectId: 'turn', attemptId: 'attempt-1', attemptNumber: 1,
        grants: [], abortSignal: controller.signal, sessionState: storage.state };
    const request: HarnessExecutionRequest = { connection: snapshot, prompt, resourceHandleId: 'test-grant', notificationKey: `notification.${id}` };
    const provider = createHarnessExecutionProvider(service, { pollMs: 20, cancelTimeoutMs: 15_000, stateForCleanup: async () => storage.state });
    return { ...storage, controller, context, request, provider };
}

function droppedTurnResponse() {
    const counts = { create: 0, turn: 0, receipt: 0 }, accepted = { sessionId: '', turnId: '' };
    return { counts, accepted, connections: { validate: service.validate.bind(service), acquire: async (binding: HarnessConnectionSnapshot) => {
        const acquired = await service.acquire(binding), create = acquired.client.create.bind(acquired.client);
        const turn = acquired.client.turn.bind(acquired.client), operation = acquired.client.operation.bind(acquired.client);
        acquired.client.create = async (...args) => { counts.create++; const result = await create(...args); accepted.sessionId = result.session.id; return result; };
        acquired.client.turn = async (...args) => { counts.turn++; const result = await turn(...args); accepted.turnId = result.turnId; throw new Error('Injected response loss after native commit'); };
        acquired.client.operation = async (...args) => { counts.receipt++; return operation(...args); };
        return acquired;
    } } };
}

describe.skipIf(!metadataFile)('installed Claude CLI through durable broker and a sandboxed project', () => {
    it('returns exact native assistant text and replays the persisted result without another invocation', async () => {
        const f = invocation('text', 'Reply with the fixed fixture text');
        const result = await f.provider.execute(f.request, f.context);
        expect(result.text).toBe('Claude harness fixture reply'); expect(result.turnId).toBeTruthy();
        const journal = f.records.get(harnessExecutionJournalKey(f.context))!.value as any;
        expect(journal.operations.create.outcome).toBe('committed'); expect(journal.operations.turn.outcome).toBe('committed');
        expect(journal.terminal).toBe('completed'); expect(journal.outputChecked).toBe(true);
        expect(await f.provider.reconcile(f.request, f.context)).toEqual({ status: 'completed', result });
    }, 60_000);

    it('bridges a durable platform approval response to the advertised native Write decision', async () => {
        await rm(resolve(metadata.root, 'export/project/fixture.md'), { force: true });
        const f = invocation('approval', 'write watcher fixture');
        const running = f.provider.execute(f.request, f.context);
        await vi.waitFor(() => expect(f.records.has(f.request.notificationKey)).toBe(true), { timeout: 30_000 });
        const notification = f.records.get(f.request.notificationKey)!.value as any;
        expect(notification.kind).toBe('approval'); expect(notification.payload.decisions).toContain('accept');
        await f.state.set(`${f.request.notificationKey}.response.${encodeURIComponent(notification.id)}`, { approved: true });
        expect((await running).text).toBe('Claude harness fixture reply');
        expect(await readFile(resolve(metadata.root, 'export/project/fixture.md'), 'utf8')).toBe('Claude watcher fixture\n');
        expect(f.records.get(f.request.notificationKey)!.version).toBe(1);
    }, 60_000);

    it('cancels the real native turn while approval is pending and confirms exact cancellation evidence', async () => {
        await rm(resolve(metadata.root, 'export/project/fixture.md'), { force: true });
        const f = invocation('cancel', 'write watcher fixture');
        const running = f.provider.execute(f.request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(f.request.notificationKey)).toBe(true), { timeout: 30_000 });
        f.controller.abort();
        await f.provider.cancel(f.request, { ...f.context, grants: [], sessionState: undefined });
        expect(await running).toBeInstanceOf(Error);
        const journal = f.records.get(harnessExecutionJournalKey(f.context))!.value as any;
        expect(journal.terminal).toBe('cancelled'); expect(journal.operations.interrupt.outcome).toBe('committed');
        expect(Object.keys(journal.operations).some(key => key.startsWith('respond-'))).toBe(false);
    }, 60_000);

    it('reopens a disk journal after a lost real turn reply and reconciles its exact native receipt without resubmission', async () => {
        const f = invocation('lost-reply', 'Reply with the fixed fixture text'), fault = droppedTurnResponse();
        const path = resolve(metadata.root, 'verification', `lost-reply-${testRunId}.json`), first = await diskState(path);
        const context = { ...f.context, sessionState: first.state };
        await expect(createHarnessExecutionProvider(fault.connections).execute(f.request, context))
            .rejects.toMatchObject({ code: 'NATIVE_OUTCOME_UNKNOWN' });
        const pending = (await first.state.get(harnessExecutionJournalKey(context)))!.value as any;
        expect(pending.operations.turn.outcome).toBe('pending'); expect(fault.accepted.turnId).toBeTruthy(); first.close();
        const reopened = await diskState(path), next = { ...context, attemptId: 'attempt-2', attemptNumber: 2, sessionState: reopened.state };
        const result = await createHarnessExecutionProvider(fault.connections, { pollMs: 20 }).reconcile(f.request, next);
        expect(result).toMatchObject({ status: 'completed', result: { ...fault.accepted, text: 'Claude harness fixture reply' } });
        expect(fault.counts).toEqual({ create: 1, turn: 1, receipt: 1 });
        const journal = (await reopened.state.get(harnessExecutionJournalKey(context)))!.value as any; reopened.close();
        expect(journal.operations.turn.outcome).toBe('committed'); expect(journal.result.turnId).toBe(fault.accepted.turnId);
        await writeFile(resolve(metadata.root, 'verification', 'lost-reply-evidence.json'), JSON.stringify({
            passed: true, fault: 'drop real committed turn reply', persistence: 'test single-writer atomic-file CAS port closed and reopened',
            processRestart: false, requestId: journal.operations.turn.requestId, epoch: journal.epoch, ...fault.accepted,
            counts: fault.counts, terminal: journal.terminal, outputChecked: journal.outputChecked, journalFile: path,
        }, null, 2));
    }, 60_000);
});
