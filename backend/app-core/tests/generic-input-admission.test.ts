import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {sha256Hex} from '@itookit/llm-context/digest';
import {FlowLibraryCommand, InputAssetCommand} from '@itookit/app-contracts';
import {FlowCommand, type FlowDraft} from '@itookit/llm-flow/contracts';
import {FlowInvocationCommand, SessionCommand, type SessionInstructionQueue} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {INPUT_ASSET_OWNER} from '../src/runtime/input-asset-store';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const cleanup: Runtime[] = [];
afterEach(async () => {for (const runtime of cleanup.splice(0)) await runtime.dispose();});
async function setup() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false}); cleanup.push(runtime);
    const flow: FlowDraft = {id: 'files' as never, name: 'File arguments', draftVersion: 1, updatedAt: 0,
        parameters: [{name: 'documents', type: 'json', widget: 'files', inputSource: 'composer.attachments', required: true, fileConstraints: {minItems: 1, maxItems: 2}}],
        nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', config: {value: '${param.documents}'}, inputs: {}}],
        edges: [], outputs: {result: {value: '${nodes.value.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const sessionId = await runtime.sessionRepository.createSession('File inputs'); await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    return {runtime, sessionId, fs: await runtime.vfs.openFileSystem('/')};
}
async function file(runtime: Runtime, text = 'Selected file') {
    const data = new TextEncoder().encode(text).buffer;
    const identity = {uploadId: '12345678-1234-4123-8123-123456789abc', name: 'notes.txt', mimeType: 'text/plain', bytes: data.byteLength, sha256: await sha256Hex(data)};
    const asset = await runtime.commandBus.execute(InputAssetCommand.ImportFile, {...identity, data});
    return {part: {type: 'file', name: identity.name, source: {type: 'asset', asset}}, identity};
}
function request(sessionId: string, id: string, part: unknown) {
    return {target: {kind: 'flow', id: 'files', version: '1'}, source: {kind: 'arguments', value: {documents: [part]}},
        submission: {id, source: {kind: 'conversation', ownerId: sessionId, id}}};
}

it('uploads and executes a zero-byte file through the real Session queue without requiring text', async () => {
    const {runtime, sessionId} = await setup(), {part, identity} = await file(runtime, '');
    expect(await runtime.commandBus.execute(InputAssetCommand.Inspect, identity)).toMatchObject({state: 'ready'});
    expect(await runtime.commandBus.execute(SessionCommand.Submit, request(sessionId, 'empty-file', part))).toBe('empty-file');
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'));
    const round = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0];
    expect(round.callInput?.admitted?.parameters).toEqual({documents: [part]});
    expect(JSON.stringify((await runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.labels?.kind === 'flow-root')!.output)).toContain(identity.sha256);
});

it('checks new and edited queued input while preserving original admission receipts after content loss', async () => {
    const {runtime, sessionId, fs} = await setup(), {part, identity} = await file(runtime);
    const initial = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'pause', expectedRevision: initial.revision});
    const original = request(sessionId, 'original-file', part); await runtime.commandBus.execute(SessionCommand.Submit, original);
    const accepted = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(accepted.items).toHaveLength(1); expect(accepted.items[0].state).toBe('pending');
    await fs.meta.assets.putAsset(INPUT_ASSET_OWNER, `${identity.sha256}.bin`, new Uint8Array([1]).buffer);
    expect(await runtime.commandBus.execute(SessionCommand.Submit, original)).toBe('original-file');
    await expect(runtime.commandBus.execute(SessionCommand.Submit, request(sessionId, 'new-file', part))).rejects.toMatchObject({code: 'INPUT_ASSET_INTEGRITY'});
    await expect(runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'update-input', id: 'original-file', expectedRevision: accepted.revision,
        source: {kind: 'arguments', value: {documents: [{...part, name: 'renamed.txt'}]}}})).rejects.toMatchObject({code: 'INPUT_ASSET_INTEGRITY'});
    const current = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(current.revision).toBe(accepted.revision); expect(current.items).toEqual(accepted.items);
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
});

it('applies readiness validation to standalone Invocation and direct Flow run admission', async () => {
    const {runtime, sessionId} = await setup(), data = new TextEncoder().encode('Missing file');
    const part = {type: 'file', name: 'missing.txt', source: {type: 'asset', asset: {kind: 'input', id: '12345678-1234-4123-8123-123456789abc',
        bytes: data.length, sha256: await sha256Hex(data), mimeType: 'text/plain'}}};
    await expect(runtime.commandBus.execute(FlowInvocationCommand.Invoke, {sessionId, flowId: 'files', revision: 1, requestId: 'missing-call', parameters: {documents: [part]}}))
        .rejects.toMatchObject({code: 'INPUT_ASSET_MISSING'});
    const flow = await runtime.commandBus.execute(FlowCommand.RevisionGet, {id: 'files', revision: 1});
    await expect(runtime.commandBus.execute(FlowCommand.RunStart, {sessionId, flow, parameters: {documents: [part]}}))
        .rejects.toMatchObject({code: 'INPUT_ASSET_MISSING'});
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
    expect(await runtime.commandBus.execute(FlowInvocationCommand.List, {sessionId})).toEqual([]);
});

it('revalidates queued materials before a new dispatch while preserving the original acceptance receipt', async () => {
    const {runtime, sessionId, fs} = await setup(), {part, identity} = await file(runtime);
    const queue = () => runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'pause', expectedRevision: (await queue()).revision});
    const original = request(sessionId, 'dispatch-file', part);
    await runtime.commandBus.execute(SessionCommand.Submit, original);
    await fs.meta.assets.putAsset(INPUT_ASSET_OWNER, `${identity.sha256}.bin`, new Uint8Array([1]).buffer);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'resume', expectedRevision: (await queue()).revision});
    await vi.waitFor(async () => {
        const current = await queue(); expect(current.paused).toBe(true);
        expect(current.items[0]).toMatchObject({id: 'dispatch-file', state: 'failed'});
    });
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
    expect(await runtime.commandBus.execute(SessionCommand.GetSubmissionReceipt, original))
        .toEqual({operationId: 'dispatch-file', status: 'accepted', evidence: 'queue'});
});
