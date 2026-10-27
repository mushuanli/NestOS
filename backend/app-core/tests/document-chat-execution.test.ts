import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {SessionCommand, type RootTargetCatalog, type SubmissionRequest} from '@itookit/llm-session/contracts';
import type {FlowDraft} from '@itookit/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {openApplicationView} from '../src/host/application-view';

it('creates a real linked Session, appends deterministic Flow calls to its branch and opens the same history', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false});
    const view = await openApplicationView(runtime);
    try {
        const flow: FlowDraft = {id: 'document-worker' as never, name: 'Document worker', exposure: 'global', draftVersion: 1, updatedAt: 0,
            layout: {}, parameters: [{name: 'request', type: 'string', inputSource: 'composer.text'}], edges: [],
            nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: '${param.request}'}}],
            outputs: {result: {value: '${nodes.value.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
        const catalog = await view.services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
        const target = catalog.entries.find(entry => entry.target.id === 'document-worker')!.target;
        const files = await view.services.vfs.openFileSystem('/home/admin/minds');
        await files.driver.createFile({parentPath: '/', name: 'linked.md', content: 'Selected text ::@anchor@'});
        const links = await view.backend.documentChatFile({files, path: '/linked.md'});
        await links.create('anchor', 'Selected text'); const reserved = await links.reserve('anchor', 'first');
        const {sessionId, branch} = reserved.endpoint!;
        await view.backend.createSessionDraft({sessionId, branchName: branch, title: 'Linked note', inputText: ''});
        const submit = async (id: string) => {
            const request: SubmissionRequest = {expectedSessionId: sessionId, expectedBranch: branch, target: {kind: 'flow', id: target.id, version: target.version}, expectedTarget: target,
                source: {kind: 'composer', text: id, attachments: [], values: {}}, submission: {id, source: {kind: 'conversation', ownerId: sessionId, id}}};
            await links.prepare('anchor', request); expect((await view.backend.submitSession(request)).status).toBe('accepted'); await links.bind('anchor', request);
            await vi.waitFor(async () => {
                const history = await runtime.sessionRepository.readHistoryChain(sessionId);
                expect(history.rounds.at(-1)?.id).toBe(id); expect(history.rounds.at(-1)?.status).toBe('completed');
            });
        };
        await submit('first');
        const other = await runtime.openConversation(sessionId);
        try {await other.commandBus.execute('vcs.branch.switch', {branchName: 'main'});} finally {await other.dispose();}
        await submit('second');
        const history = await runtime.sessionRepository.readHistoryChain(sessionId); expect(history.rounds.map(round => round.id)).toEqual(['first', 'second']);
        expect((await links.get('anchor')).link?.binding).toMatchObject({sessionId, branch, initialRoundId: 'first'});
        const opened = await view.backend.openSessionView(sessionId);
        try {expect(opened.manifest.id).toBe(sessionId); expect(opened.manifest.branches[branch]).toBe('second');} finally {await opened.dispose();}
        expect((await view.backend.documentChatBacklinks(sessionId, branch))[0].source.path).toBe('/linked.md');
        await links.dispose();
    } finally {await view.close(); await runtime.dispose();}
});
