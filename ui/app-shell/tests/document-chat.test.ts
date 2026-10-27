// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createDocumentChatFactory} from '../src/browser/document-chat';
import type {AiChatHost} from '@itookit/mdxeditor';
import type {ApplicationBackend, ApplicationServices} from '@itookit/app-contracts/services';
import type {EditorFactory} from '@itookit/ui-common';

const entry = (id: string, kind: 'agent' | 'flow' = 'agent') => ({name: id, target: {kind, id, version: '1', digest: id}});
async function fixture(session = true) {
    const choices = [entry('flow', 'flow'), entry('other'), entry('default'), entry('current')];
    const manifest = {currentBranch: 'main', branches: {main: null, review: null},
        uiState: {branchDrafts: {main: {inputAgentId: 'current'}, review: {inputAgentId: 'other'}}}};
    const assets = {dispose: vi.fn(async () => {})};
    const services = {commandBus: {execute: vi.fn(async (name: string) => name === 'session.targets.list'
        ? {entries: choices, issues: []} : {status: 'not-accepted'})},
        sessionRepository: {getManifest: vi.fn(async () => manifest), openAttachments: vi.fn(async () => assets)}};
    const editor = {flushPendingSave: vi.fn(async () => {}), getText: () => 'document'};
    let configured: any;
    const base = vi.fn(async (_container, options) => {configured = options; return editor;}) as unknown as EditorFactory;
    const prepare = vi.fn(async ({request}) => request), navigate = vi.fn(async () => {});
    const backend = {createSessionDraft: vi.fn(async () => {}), submitSession: vi.fn(async () => ({operationId: 'operation-1', status: 'accepted'})),
        prepareSessionBranch: vi.fn(async request => request)};
    const factory = createDocumentChatFactory(base, services as unknown as ApplicationServices, backend as unknown as ApplicationBackend, prepare, navigate);
    const target = session ? {kind: 'session' as const, sessionId: 'session'} : {kind: 'file' as const, path: '/note.md'};
    await factory(document.createElement('div'), {target});
    const host: AiChatHost = session ? configured.defaultPluginOptions['interaction:ai-chat'].createHost({documentPath: 'session:session/messages/m', branch: 'review', roundId: 'round', role: 'assistant'})
        : configured.plugins[0][1].host;
    return {host, manifest, services, backend, assets, prepare, navigate};
}

it('uses the source branch agent and falls back to default when its choice is unavailable', async () => {
    const f = await fixture(), context = {source: {defaultPrompt: 'ask'}, signal: new AbortController().signal};
    expect(JSON.parse((await f.host.getDefaultTarget!(context))!.id).id).toBe('other');
    f.manifest.uiState.branchDrafts.review.inputAgentId = 'missing';
    expect(JSON.parse((await f.host.getDefaultTarget!(context))!.id).id).toBe('default');
    const file = await fixture(false);
    expect(JSON.parse((await file.host.getDefaultTarget!(context))!.id).id).toBe('default');
});

it('disposes attachment views after preparation failure without masking the original error', async () => {
    const f = await fixture(false), error = new Error('Input validation failed'); f.prepare.mockRejectedValueOnce(error);
    await expect(f.host.onSubmit({operationId: 'operation-1', prompt: 'ask', attachments: [],
        target: {kind: 'agent', id: JSON.stringify(entry('default').target), label: 'Default'},
        source: {documentPath: '/note.md', defaultPrompt: 'ask'}, signal: new AbortController().signal})).rejects.toBe(error);
    expect(f.assets.dispose).toHaveBeenCalledOnce(); expect(f.backend.submitSession).not.toHaveBeenCalled();
});

it('appends anchored sends to one branch, quotes the selection and navigates only on explicit open', async () => {
    const choices = [entry('default')], endpoint = {sessionId: 'linked-session', branch: 'chat-anchor'};
    let linked: any = {anchorId: 'anchor', selection: 'Selected passage', defaultPrompt: '', status: 'unbound', endpoint};
    const port = {get: vi.fn(async () => ({link: linked})), create: vi.fn(async () => linked), reserve: vi.fn(async () => linked),
        prepare: vi.fn(async (_id, request) => {linked.pending = request;}), bind: vi.fn(async (_id, request) => {
            linked = {...linked, pending: undefined, status: 'bound', binding: linked.binding ?? {...endpoint, initialRoundId: request.submission.id}}; return linked;
        }), reconcile: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}), dispose: vi.fn(async () => {})};
    const manifest = {currentBranch: 'main', branches: {main: null} as Record<string, null>};
    const services = {commandBus: {execute: vi.fn(async name => name === 'session.targets.list' ? {entries: choices} : {status: 'not-accepted'})},
        sessionRepository: {getManifest: vi.fn(async () => manifest), openAttachments: vi.fn(async () => ({dispose: async () => {}}))}};
    const backend = {documentChatFile: vi.fn(async () => port), createSessionDraft: vi.fn(async () => {manifest.branches[endpoint.branch] = null;}),
        submitSession: vi.fn(async request => ({operationId: request.submission.id, status: 'accepted'}))};
    let configured: any, saved!: () => void;
    const editor = {flushPendingSave: vi.fn(async () => {}), getText: () => 'Other text ::@anchor@', destroy: vi.fn(async () => {}),
        on: (_name, callback) => {saved = callback; return () => {};}};
    const base = (async (_container, options) => {configured = options; return editor;}) as EditorFactory;
    const prepare = vi.fn(async ({request}) => request), navigate = vi.fn(async () => {});
    const factory = createDocumentChatFactory(base, services as any, backend as any, prepare, navigate);
    const mounted = await factory(document.createElement('div'), {target: {kind: 'file', path: '/note.md'},
        files: {fs: {driver: {getNode: async () => ({metadata: {}})}}} as any});
    const host: AiChatHost = configured.plugins[0][1].host;
    const input = {prompt: 'Question', attachments: [], target: {kind: 'agent' as const, id: JSON.stringify(choices[0].target), label: 'Default'},
        source: {anchorId: 'anchor', documentPath: '/note.md', defaultPrompt: ''}, signal: new AbortController().signal};
    await host.onSubmit({...input, operationId: 'first'}); await host.onSubmit({...input, operationId: 'second'});
    expect(backend.createSessionDraft).toHaveBeenCalledOnce(); expect(backend.submitSession).toHaveBeenCalledTimes(2);
    expect(backend.submitSession.mock.calls.map(([request]) => [request.expectedSessionId, request.expectedBranch])).toEqual([
        [endpoint.sessionId, endpoint.branch], [endpoint.sessionId, endpoint.branch]]);
    const quoted = prepare.mock.calls[0][0].files[0]; expect(quoted.size).toBe(new Blob(['Selected passage']).size);
    expect(linked.binding.initialRoundId).toBe('first'); expect(navigate).not.toHaveBeenCalled();
    linked.pending = structuredClone(backend.submitSession.mock.calls[0][0]);
    await expect(host.onSubmit({...input, prompt: 'Changed', operationId: 'changed'})).rejects.toMatchObject({code: 'SUBMISSION_PENDING'});
    expect((await host.getAnchor!({source: input.source, signal: input.signal})).defaultPrompt).toBe('Question');
    await host.onSubmit({...input, operationId: 'reopened-retry'});
    expect(backend.submitSession.mock.calls[2][0].submission.id).toBe('first');
    expect(backend.createSessionDraft).toHaveBeenCalledOnce();

    await host.openConversation!({source: input.source, signal: input.signal}); expect(navigate).toHaveBeenCalledOnce();
    saved(); await mounted.destroy(); expect(port.reconcile).toHaveBeenCalledWith(['anchor']); expect(port.dispose).toHaveBeenCalledOnce();
});
