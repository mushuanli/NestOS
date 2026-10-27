import {sessionRoute, DOCUMENT_CHAT_META_KEY} from '@itookit/app-contracts';
import {createModuleLogger, t, type NavigationRequest} from '@itookit/common';
import {SessionCommand, type RootCallTarget, type RootTargetCatalog, type SubmissionRequest, type SubmissionReceipt} from '@itookit/llm-session/contracts';
import type {AiChatHost, AiChatSubmitRequest} from '@itookit/mdxeditor';
import type {ApplicationBackend, ApplicationServices, DocumentChatFile, DocumentChatLink} from '@itookit/app-contracts/services';
import type {EditorFactory, IEditor} from '@itookit/ui-common';
import type {AppUI} from '../types';

const log = createModuleLogger('document-chat');
type Association = {sessionId?: string; projectFolder?: string};
interface Pending {anchored?: boolean; documentPath: string; sessionId: string; branchName: string; branchFrom?: SubmissionRequest['branchFrom']; request?: SubmissionRequest}
interface MessageAnchor {documentPath: string; branch?: string; roundId?: string; role: string; userIndex?: number}
/** Enable the opt-in Markdown input using the same published call preparation as chat. */
export function createDocumentChatFactory(factory: EditorFactory, services: ApplicationServices, backend: ApplicationBackend,
    prepare: AppUI['prepareChatSubmission'], navigate: (request: NavigationRequest) => Promise<void>): EditorFactory {
    return async (container, options) => {
        const target = options.target;
        const isSession = target?.kind === 'session';
        if (!prepare || !target || !isSession && (target.kind !== 'file' || options.contentFormat === 'text' || !/\.(md|mdx|markdown)$/i.test(target.path))) return factory(container, options);
        let documentPath = target.kind === 'file' ? target.path : `session:${target.kind === 'session' ? target.sessionId : ''}`, editor: IEditor | undefined;
        const supplied = options.defaultPluginOptions?.['interaction:ai-chat'] as {association?: Association; host?: AiChatHost} | undefined;
        if (supplied?.host) return factory(container, options);
        const association = supplied?.association ?? ('sessionId' in target && target.sessionId ? {sessionId: target.sessionId} : undefined);
        const pending = new Map<string, Pending>(), messageAnchors = new Map<string, MessageAnchor>();
        let reading: Promise<RootTargetCatalog> | undefined;
        const catalog = () => reading ??= services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets)
            .finally(() => {reading = undefined;});
        const defaultTarget = async (branch?: string) => preferredTarget(await catalog(), services, target.kind === 'session' ? target.sessionId : association?.sessionId, branch);
        let links: Promise<DocumentChatFile> | undefined;
        const fileLinks = () => links ??= backend.documentChatFile({files: options.files!.fs, path: documentPath, projectFolder: association?.projectFolder});
        const host: AiChatHost = {
            listTargets: async ({signal}) => {
                const choices = await catalog(); signal.throwIfAborted();
                return choices.entries.map(choice => ({kind: choice.target.kind, id: JSON.stringify(choice.target), label: choice.name}));
            },
            getDefaultTarget: async ({source, signal}) => {
                const linked = source.anchorId && target.kind === 'file' && options.files ? (await (await fileLinks()).get(source.anchorId)).link : undefined;
                const frozenTarget = linked?.pending?.expectedTarget;
                if (frozenTarget) {
                    const choice = (await catalog()).entries.find(entry => entry.target.kind === frozenTarget.kind && entry.target.id === frozenTarget.id && entry.target.digest === frozenTarget.digest);
                    signal.throwIfAborted();
                    if (choice) return {kind: choice.target.kind, id: JSON.stringify(choice.target)};
                }
                const binding = linked && ['bound', 'detached'].includes(linked.status) ? linked.binding : undefined;
                const choice = binding ? await preferredTarget(await catalog(), services, binding.sessionId, binding.branch) : await defaultTarget();
                signal.throwIfAborted(); return choice;
            },
            onSubmit: async input => {
                const started = Date.now(); let stage = 'validate';
                try {
                    input.signal.throwIfAborted();
                    if (input.source.documentPath !== documentPath && !(isSession && input.source.documentPath?.startsWith(documentPath + '/messages/'))) throw failure('DOCUMENT_CHANGED', 'Document changed; reopen the chat input');
                    if (!/^[\w-]{1,128}$/.test(input.operationId)) throw failure('INVALID_OPERATION_ID', 'Invalid chat submission identity');
                    let operation = pending.get(input.operationId);
                    if (operation && operation.documentPath !== input.source.documentPath) throw failure('DOCUMENT_CHANGED', 'Submission belongs to another document');
                    if (!operation) {
                        let linked: DocumentChatLink | undefined;
                        if (input.source.anchorId && target.kind === 'file' && options.files) {
                            const port = await fileLinks();
                            const observed = await port.get(input.source.anchorId);
                            if (!observed.link) await port.create(input.source.anchorId, '', input.source.defaultPrompt);
                            const previous = observed.link?.pending;
                            if (previous && (previous.source?.kind !== 'composer' || previous.source.text !== input.prompt || JSON.stringify(previous.expectedTarget) !== input.target.id))
                                throw failure('SUBMISSION_PENDING', t('editor.ai.pendingSubmission'));
                            linked = await port.reserve(input.source.anchorId, previous?.submission?.id ?? input.operationId);
                            if (linked.pending) operation = {documentPath: input.source.documentPath!, anchored: true,
                                sessionId: linked.pending.expectedSessionId!, branchName: linked.pending.expectedBranch!, request: linked.pending};
                        }
                        const anchor = messageAnchors.get(input.source.documentPath!);
                        if (isSession && (!anchor?.roundId || !anchor.branch || !['user', 'assistant'].includes(anchor.role)))
                            throw failure('MESSAGE_ANCHOR_UNAVAILABLE', 'This message has no persisted branch anchor');
                        operation ??= {documentPath: input.source.documentPath!, anchored: !!linked,
                            sessionId: linked?.binding?.sessionId ?? linked?.endpoint?.sessionId ?? (target.kind === 'session' ? target.sessionId : input.operationId),
                            branchName: linked?.binding?.branch ?? linked?.endpoint?.branch ?? input.operationId.replace(/-/g, '').slice(0, 6), ...(anchor ? {branchFrom: {branch: anchor.branch!, roundId: anchor.roundId!,
                                role: anchor.role as 'user' | 'assistant', ...(anchor.userIndex === undefined ? {} : {userIndex: anchor.userIndex})}} : {})};
                        pending.set(input.operationId, operation);
                    }
                    if (!operation.request) {
                        stage = 'save-document'; await editor?.flushPendingSave?.(); input.signal.throwIfAborted();
                        stage = 'prepare';
                        const selected = operation.anchored ? (await (await fileLinks()).get(input.source.anchorId!)).link?.selection : undefined;
                        operation.request = await prepareRequest(input, operation, association, options, services, backend, prepare,
                            selected || (isSession ? undefined : editor?.getText()));
                    }
                    if (operation.anchored) await (await fileLinks()).prepare(input.source.anchorId!, operation.request);
                    stage = 'admission'; await admit(operation.request, services, backend);
                    trace(input.operationId, stage, started);
                    if (operation.anchored) {
                        stage = 'bind-document'; await (await fileLinks()).bind(input.source.anchorId!, operation.request);
                        trace(input.operationId, stage, started); return {branchId: operation.branchName};
                    }
                    if (!input.signal.aborted) {stage = 'navigate'; await navigate({target: 'chat', resourceId: sessionRoute(operation.sessionId, operation.branchName)});}
                    trace(input.operationId, stage, started); return {branchId: operation.branchName};
                } catch (error) {trace(input.operationId, stage, started, error); throw error;}
            },
        };
        if (target.kind === 'file' && options.files) {
            host.createAnchor = async ({source, selection, signal}) => {
                signal.throwIfAborted(); await (await fileLinks()).create(source.anchorId, selection, source.defaultPrompt);
            };
            host.getAnchor = async ({source, signal, includeResponse}) => {
                if (!source.anchorId) return {status: 'unbound'};
                const {link, response, activity} = await (await fileLinks()).get(source.anchorId, includeResponse); signal.throwIfAborted();
                return {status: link?.status === 'bound' || link?.status === 'detached' && !!link.binding ? 'bound' : link?.status === 'missing' ? 'missing' : 'unbound',
                    defaultPrompt: link?.pending?.source?.kind === 'composer' ? link.pending.source.text : link?.defaultPrompt, selection: link?.selection, response, activity};
            };
            host.openConversation = async ({source, signal}) => {
                const {link} = await (await fileLinks()).get(source.anchorId!); signal.throwIfAborted();
                if (!link?.binding || !['bound', 'detached'].includes(link.status)) throw failure('BRANCH_MISSING', t('editor.ai.branchMissing'));
                await navigate({target: 'chat', resourceId: sessionRoute(link.binding.sessionId, link.binding.branch)});
            };
            host.observeAnchor = (_context, changed) => {
                let closed = false, stop: (() => void) | undefined;
                void fileLinks().then(port => {if (!closed) stop = port.subscribe(changed);}).catch(error => trace('metadata', 'observe-anchor', Date.now(), error));
                return () => {closed = true; stop?.();};
            };
        }
        editor = await factory(container, isSession ? {...options, defaultPluginOptions: {...options.defaultPluginOptions,
            'interaction:ai-chat': {createHost: (source: MessageAnchor) => {
                messageAnchors.set(source.documentPath, {...source});
                return {...host, getDefaultTarget: async ({signal}: {signal: AbortSignal}) => {
                    const choice = await defaultTarget(source.branch); signal.throwIfAborted(); return choice;
                }};
            }}}}
            : {...options, plugins: [...(options.plugins ?? []), ['interaction:ai-chat', {host}]]});
        const rename = editor.updateNodeId?.bind(editor);
        if (rename) editor.updateNodeId = path => {
            documentPath = path; const previous = links; links = undefined;
            void previous?.then(port => port.dispose()).catch(() => {}); rename(path);
        };
        if (target.kind === 'file' && options.files) {
            const destroy = editor.destroy.bind(editor);
            let synchronizing: Promise<void> = Promise.resolve();
            const reconcile = async (markdown: string) => {
                const stored = (await options.files!.fs.driver.getNode(documentPath))?.metadata[DOCUMENT_CHAT_META_KEY];
                if (!links && !stored && !markdown.includes('::@')) return;
                const {aiChatAnchorIds} = await import('@itookit/mdxeditor');
                const ids = aiChatAnchorIds(markdown);
                if (links || ids.length || stored) await (await fileLinks()).reconcile(ids);
            };
            const stop = editor.on('saved', () => {
                const markdown = editor!.getText();
                synchronizing = synchronizing.then(() => reconcile(markdown)).catch(error => trace('metadata', 'reconcile-document', Date.now(), error));
            });
            editor.destroy = async () => {
                try {await destroy(); await synchronizing;} finally {stop(); await (await links)?.dispose();}
            };
        }
        return editor;
    };
}
async function preferredTarget(catalog: RootTargetCatalog, services: ApplicationServices, sessionId?: string, branch?: string) {
    let selected: {kind: 'agent' | 'flow'; id: string} | undefined;
    if (sessionId) {
        const manifest = await services.sessionRepository.getManifest(sessionId), current = branch ?? manifest.currentBranch;
        const draft = manifest.uiState?.branchDrafts?.[current];
        selected = draft?.inputTarget ?? (draft?.inputAgentId ? {kind: 'agent', id: draft.inputAgentId} : undefined);
        const head = manifest.branches[current];
        if (!selected && head) {
            const content = await services.sessionRepository.readDocument(sessionId, `round-${head}.json`);
            const round = content ? JSON.parse(content) as {agentId?: string; target?: {kind: 'agent' | 'flow'; id: string}} : undefined;
            selected = round?.target ?? (round?.agentId ? {kind: 'agent', id: round.agentId} : undefined);
        }
        selected ??= manifest.createdWithAgentId ? {kind: 'agent', id: manifest.createdWithAgentId} : undefined;
    }
    const choice = catalog.entries.find(choice => choice.target.kind === selected?.kind && choice.target.id === selected.id)
        ?? catalog.entries.find(choice => choice.target.kind === 'agent' && choice.target.id === 'default')
        ?? catalog.entries.find(choice => choice.target.kind === 'agent');
    return choice ? {kind: choice.target.kind, id: JSON.stringify(choice.target)} : undefined;
}

async function prepareRequest(input: AiChatSubmitRequest, operation: Pending, association: Association | undefined,
    options: Parameters<EditorFactory>[1], services: ApplicationServices, backend: ApplicationBackend,
    prepare: NonNullable<AppUI['prepareChatSubmission']>, documentText?: string): Promise<SubmissionRequest> {
    const catalog = await services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const choice = catalog.entries.find(choice => JSON.stringify(choice.target) === input.target.id && choice.target.kind === input.target.kind);
    if (!choice) throw failure('CALL_TARGET_CHANGED', 'Selected Agent or Flow changed; select it again');
    const files = await attachments(input, options); input.signal.throwIfAborted();
    if (documentText !== undefined) {
        const file = new File([documentText], operation.documentPath.split('/').pop() ?? 'document.md', {type: 'text/markdown'});
        if (file.size > 256 * 1024) throw failure('DOCUMENT_CONTEXT_TOO_LARGE', t('editor.ai.documentTooLarge', {limit: '256 KiB'}));
        files.unshift(file);
    }
    if (!operation.branchFrom && !(operation.anchored && Object.hasOwn((await services.sessionRepository.getManifest(operation.sessionId)
        .catch(error => {if ((error as {code?: string}).code === 'ENOENT') return {branches: {}}; throw error;})).branches, operation.branchName))) await backend.createSessionDraft({sessionId: operation.sessionId, branchName: operation.branchName,
        title: promptSessionTitle(input.prompt) || options.title || operation.documentPath.split('/').pop() || 'Chat', inputText: '', inputTarget: choice.target, source: association});
    input.signal.throwIfAborted();
    const assets = await services.sessionRepository.openAttachments(operation.sessionId);
    try {
        const prepared = await prepare({commands: services.commandBus, agents: services.agentService, choice,
            request: requestOf(input, operation, choice), files, assets, signal: input.signal});
        return operation.branchFrom ? await backend.prepareSessionBranch(prepared) : prepared;
    }
    finally {await assets.dispose();}
}
function promptSessionTitle(prompt: string): string {
    const line = prompt.split(/\r?\n/).find(line => line.trim())?.trim().replace(/\s+/g, ' ') ?? '';
    return Array.from(line).slice(0, 30).join('');
}
function requestOf(input: AiChatSubmitRequest, operation: Pending, choice: RootCallTarget): SubmissionRequest {
    const id = input.operationId;
    return {expectedSessionId: operation.sessionId, expectedBranch: operation.branchName, ...(operation.branchFrom ? {branchFrom: {...operation.branchFrom}} : {}),
        target: {kind: choice.target.kind, id: choice.target.id, version: choice.target.version}, expectedTarget: {...choice.target},
        source: {kind: 'composer', text: input.prompt, attachments: [], values: {}},
        submission: {id, source: {kind: 'conversation', ownerId: operation.sessionId, id}}};
}
async function attachments(input: AiChatSubmitRequest, options: Parameters<EditorFactory>[1]): Promise<File[]> {
    const {createAssetProvider} = await import('@itookit/mdx-adapter');
    const provider = createAssetProvider(options.files?.fs, () => input.source.documentPath, options.assets), files: File[] = [];
    for (const item of input.attachments) {
        input.signal.throwIfAborted();
        if (item.kind === 'file') files.push(item.file);
        else {if (!provider) throw failure('ATTACHMENT_SOURCE_UNAVAILABLE', 'Document attachment storage is unavailable');
            const bytes = await provider.read(item.id); if (!bytes) throw failure('ATTACHMENT_NOT_FOUND', 'Selected document attachment is unavailable');
            files.push(new File([bytes], item.name, {type: item.mimeType}));}
    }
    return files;
}
async function admit(request: SubmissionRequest, services: ApplicationServices, backend: ApplicationBackend): Promise<void> {
    const inspect = () => services.commandBus.execute<SubmissionReceipt>(SessionCommand.InspectSubmissionReceipt, request);
    if ((await inspect()).status === 'accepted') return;
    let receipt: SubmissionReceipt;
    try {receipt = await backend.submitSession(request);}
    catch (error) {const observed = await inspect().catch(() => undefined); if (observed?.status === 'accepted') return; throw error;}
    if (receipt.operationId !== request.submission!.id || receipt.status !== 'accepted')
        throw failure('SUBMISSION_UNKNOWN', 'Submission receipt is not confirmed; retry to query the original request');
}
function failure(code: string, message: string): Error {return Object.assign(new Error(message), {code});}
function trace(operationId: string, stage: string, started: number, error?: unknown): void {
    const code = (error as {code?: string})?.code;
    try {const data = {operationId, stage, result: error ? 'failure' : 'success', durationMs: Date.now() - started,
        ...(error ? {code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'DOCUMENT_CHAT_FAILED'} : {})};
        if (error) log.warn('document.chat', data); else log.info('document.chat', data);
    } catch { /* Diagnostics cannot alter submission admission. */ }
}
