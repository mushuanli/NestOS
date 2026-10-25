import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {AgentDefinition, AgentPublishRequest, AgentRevisionContent} from '@itookit/kernel-adapters/contracts';
import {AgentRevisionStore, AGENT_REVISIONS_FILE} from '../src/persistence/agent-revisions';
import {agentRevisionDigest, agentSourceDigest} from '../src/services/agent-definition-digest';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function setup() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const backing = await manager.openFileSystem('/');
    const fs = {driver: backing.driver, meta: {seq: {
        getEntry: backing.meta.seq!.getEntry.bind(backing.meta.seq), transaction: backing.meta.seq!.transaction!.bind(backing.meta.seq),
    }}} as unknown as typeof backing;
    return {store: new AgentRevisionStore(fs), fs, backing};
}
function content(prompt = 'Private policy'): AgentRevisionContent {
    const definition: AgentDefinition = {id: 'agent', name: 'Agent', type: 'agent', version: 'legacy-label', config: {systemPrompt: prompt}};
    return {definition, sourceDigest: agentSourceDigest(definition)};
}
function request(value: AgentRevisionContent, operationId = 'publish-one', expectedPublishedVersion: string | null = null): AgentPublishRequest {
    return {agentId: value.definition.id, operationId, expectedSourceDigest: value.sourceDigest,
        expectedRevisionDigest: agentRevisionDigest(value), expectedPublishedVersion};
}

it('keeps publication reads empty and side-effect free until an explicit publish', async () => {
    const f = await setup(), value = content();
    expect(await f.store.get('agent')).toBeNull(); expect(await f.store.receipt(request(value))).toBeNull();
    expect(await f.fs.driver.exists(AGENT_REVISIONS_FILE)).toBe(false);
});

it('persists a content-addressed version and returns copies without exposing a mutable published body', async () => {
    const f = await setup(), value = content(), req = request(value), revision = await f.store.publish(req, value);
    expect(revision.target).toEqual({kind: 'agent', id: 'agent', version: `ap1_${req.expectedRevisionDigest}`, digest: req.expectedRevisionDigest});
    revision.definition.config.systemPrompt = 'Caller mutation';
    expect((await f.store.get('agent'))?.definition.config.systemPrompt).toBe('Private policy');
    expect(await f.store.receipt(req)).toEqual(await f.store.get('agent'));
    expect(await new AgentRevisionStore(f.fs).get('agent', revision.target.version)).toEqual(await f.store.get('agent'));
});

it('rejects a changed source, dependency snapshot and reused operation before publishing another definition', async () => {
    const f = await setup(), value = content(), req = request(value); await f.store.publish(req, value);
    await expect(f.store.publish(req, content('Different source'))).rejects.toMatchObject({code: 'AGENT_SOURCE_CHANGED'});
    const other = content('Different source'), changed = request(other);
    await expect(f.store.publish(changed, other)).rejects.toMatchObject({code: 'AGENT_PUBLICATION_OPERATION_CONFLICT'});
    await expect(f.store.publish({...req, operationId: 'different', expectedRevisionDigest: 'a'.repeat(64)}, value))
        .rejects.toMatchObject({code: 'AGENT_PUBLICATION_DEPENDENCY_CHANGED'});
    expect((await f.store.get('agent'))?.sourceDigest).toBe(value.sourceDigest);
});

it('allows one winner when different publications race the same head', async () => {
    const f = await setup(), first = content('First policy'), second = content('Second policy');
    const results = await Promise.allSettled([f.store.publish(request(first, 'first'), first), f.store.publish(request(second, 'second'), second)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(row => row.status === 'fulfilled')!;
    if (winner.status === 'fulfilled') expect((await f.store.get('agent'))?.target).toEqual(winner.value.target);
    expect(results.find(row => row.status === 'rejected')).toMatchObject({reason: {code: expect.stringMatching(/^AGENT_PUBLICATION_(CONFLICT|WRITE_UNCONFIRMED)$/)}});
});

it('confirms a committed transaction whose reply was lost using the original durable receipt', async () => {
    const f = await setup(), transact = f.fs.meta.seq!.transaction!.bind(f.fs.meta.seq), value = content(), req = request(value);
    vi.spyOn(f.fs.meta.seq!, 'transaction').mockImplementationOnce(async work => {await transact(work); throw new Error('Lost commit acknowledgement');});
    expect(await f.store.publish(req, value)).toEqual(await f.store.receipt(req));
});

it('retains an unknown publication identity after a failed write and supports exact user-requested retry', async () => {
    const f = await setup(), value = content(), req = request(value);
    vi.spyOn(f.fs.meta.seq!, 'transaction').mockRejectedValueOnce(Object.assign(new Error('Private storage path'), {code: 'ENOSPC'}));
    await expect(f.store.publish(req, value)).rejects.toMatchObject({code: 'AGENT_PUBLICATION_WRITE_UNCONFIRMED', outcome: 'unknown'});
    expect(await f.store.receipt(req)).toBeNull(); const published = await f.store.publish(req, value);
    expect(await f.store.receipt(req)).toEqual(published);
});

it('replays an old publication receipt after a newer publication without moving the latest pointer backwards', async () => {
    const f = await setup(), first = content('First'), firstRequest = request(first), old = await f.store.publish(firstRequest, first);
    const second = content('Second'), current = await f.store.publish(request(second, 'second', old.target.version), second);
    expect(await f.store.publish(firstRequest, first)).toEqual(old);
    expect((await f.store.get('agent'))?.target).toEqual(current.target);
    expect(await f.store.get('agent', old.target.version)).toEqual(old);
});

it('rejects a corrupt stored revision instead of treating it as an unpublished legacy Agent', async () => {
    const f = await setup(), value = content(); await f.store.publish(request(value), value);
    await f.backing.meta.seq!.walkEntries(AGENT_REVISIONS_FILE, async entry => {
        if (entry.key.startsWith('revision:')) {
            const record = JSON.parse(entry.value); record.definition.config.systemPrompt = 'Tampered policy';
            await f.backing.meta.seq!.setEntry(AGENT_REVISIONS_FILE, entry.key, JSON.stringify(record));
        }
        return true;
    });
    await expect(f.store.get('agent')).rejects.toMatchObject({code: 'AGENT_REVISION_INTEGRITY'});
});

it('refuses credentials, unsupported dependencies and unknown snapshot fields before writing publication storage', async () => {
    const f = await setup(), value = content();
    for (const changed of [
        {...value, definition: {...value.definition, config: {...value.definition.config, apiKey: 'PRIVATE_KEY'}}},
        {...value, flow: {id: 'unexpected', revision: 1, digest: 'digest'}},
        {...value, unknownPolicy: 'not covered by the snapshot digest'},
    ]) {
        await expect(f.store.publish(request(changed as AgentRevisionContent), changed as AgentRevisionContent))
            .rejects.toMatchObject({code: 'AGENT_PUBLICATION_DEFINITION_INVALID'});
    }
    expect(await f.fs.driver.exists(AGENT_REVISIONS_FILE)).toBe(false);
});

it('leaves business argument names to the Flow contract instead of rejecting valid header data by name', async () => {
    const f = await setup(), base = content();
    const definition: AgentDefinition = {...base.definition, execution: {kind: 'flow', flowId: 'request-flow', revision: 1,
        parameters: {headers: {accept: 'application/json'}, password: 'business-field-placeholder'}}};
    const value: AgentRevisionContent = {definition, sourceDigest: agentSourceDigest(definition), flow: {id: 'request-flow', revision: 1, digest: 'flow-digest'}};
    expect((await f.store.publish(request(value), value)).definition.execution).toEqual(definition.execution);
});
