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
