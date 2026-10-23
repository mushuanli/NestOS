import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMindOSNodeDriver, type HarnessClient, type HarnessEvents, type RemoteProject } from '@itookit/mindos-node-driver';

const metadataFile = process.env.MINDOS_HARNESS_LIVE_METADATA;
interface Metadata { endpoint: string; project: RemoteProject; credentialFile: string; profileId: string; root: string; gatewayPid: number }
interface Target { client: HarnessClient; metadata: Metadata; epoch: string; prefix: string; directory: string }

async function childCount(pid: number) {
    const tasks = await readdir(`/proc/${pid}/task`), children = new Set<string>();
    for (const task of tasks) {
        const ids = await readFile(`/proc/${pid}/task/${task}/children`, 'utf8').catch(() => '');
        for (const id of ids.trim().split(/\s+/).filter(Boolean)) children.add(id);
    }
    return children.size;
}

async function completed(target: Target, sessionId: string, turnId: string) {
    let cursor: { after: number; eventEpoch: string } | undefined, terminal = '', text = '';
    await vi.waitFor(async () => {
        const page: HarnessEvents = await target.client.eventSnapshot(target.metadata.profileId, cursor);
        cursor = { after: page.cursor, eventEpoch: page.epoch };
        for (const event of page.events) {
            const p = event.message.params as any;
            if (p?.threadId !== sessionId) continue;
            if (event.message.method === 'item/completed' && p.turnId === turnId && p.item?.type === 'agentMessage') text += p.item.text ?? '';
            if (event.message.method === 'turn/completed' && p.turn?.id === turnId) terminal = p.turn.status;
        }
        expect(terminal).toBe('completed'); expect(text).toBe('Claude harness fixture reply');
    }, { timeout: 60_000, interval: 50 });
    return text;
}

async function invoke(target: Target, index: number, priorSession?: string) {
    const { client, metadata, epoch, prefix } = target, started = Date.now();
    const createRequestId = `${prefix}-create-${index}`, turnRequestId = `${prefix}-turn-${index}`;
    const sessionId = priorSession ?? (await client.create(metadata.profileId, metadata.project.id, { epoch, requestId: createRequestId })).session.id;
    const { turnId } = await client.turn(metadata.profileId, sessionId, 'Reply with the fixed fixture text', { epoch, requestId: turnRequestId });
    const text = await completed(target, sessionId, turnId), children = await childCount(metadata.gatewayPid);
    expect(children).toBeLessThanOrEqual(16);
    const record = { index, sessionId, turnId, createRequestId, turnRequestId, status: 'completed',
        outputLength: text.length, outputSha256: createHash('sha256').update(text).digest('hex'), durationMs: Date.now() - started,
        gatewayChildCount: children, output: text };
    await writeFile(join(target.directory, `case-${String(index).padStart(2, '0')}.json`), JSON.stringify(record, null, 2) + '\n');
    return record;
}

describe.skipIf(!metadataFile)('installed Claude capacity with a local fixed model peer', () => {
    it('executes twenty independent sessions, preserves evicted history and receipts, and resumes the first', async () => {
        const metadata: Metadata = JSON.parse(await readFile(resolve(metadataFile!), 'utf8'));
        const prefix = randomUUID(), directory = join(metadata.root, `capacity-${prefix}`); await mkdir(directory);
        const driver = createMindOSNodeDriver(); driver.setCredential(prefix, await readFile(metadata.credentialFile, 'utf8'));
        const projectClient = driver.projects({ endpoint: metadata.endpoint, credentialRef: prefix });
        const project = await projectClient.read(metadata.project.id), client = projectClient.harness(project);
        try {
            const descriptor = await client.profiles(), target: Target = { client, metadata, epoch: descriptor.epoch, prefix, directory };
            const cases = []; for (let index = 0; index < 20; index++) cases.push(await invoke(target, index));
            const first = cases[0], history = await client.read(metadata.profileId, first.sessionId);
            expect(history.session.owned).toBe(false); expect(JSON.stringify(history.turns)).toContain('Claude harness fixture reply');
            const receipt = await client.operation(metadata.profileId, first.turnRequestId, { epoch: descriptor.epoch });
            expect(receipt).toMatchObject({ outcome: 'committed', result: { turnId: first.turnId } });
            expect((await client.resume(metadata.profileId, first.sessionId, { epoch: descriptor.epoch, requestId: `${prefix}-resume` })).session.id).toBe(first.sessionId);
            cases.push(await invoke(target, 20, first.sessionId));
            await writeFile(join(directory, 'summary.json'), JSON.stringify({ passed: true, cloudModel: false, nativeCLI: true,
                independentSessions: 20, resumedSessions: 1, preservedHistory: true, preservedReceipt: true, cases }, null, 2) + '\n');
        } finally { await client.close(); await projectClient.close(); await driver.dispose(); }
    }, 300_000);
});
