import {createModuleLogger, type NavigationRequest} from '@itookit/common';
import {SessionCommand, type RootCallTarget, type RootTargetCatalog, type SubmissionRequest, type SubmissionReceipt} from '@itookit/llm-session/contracts';
import type {AiChatHost, AiChatSubmitRequest} from '@itookit/mdxeditor';
import type {ApplicationBackend, ApplicationServices} from '@itookit/app-contracts/services';
import type {EditorFactory, IEditor} from '@itookit/ui-common';
import type {AppUI} from '../types';

const log = createModuleLogger('document-chat');
type Association = {sessionId?: string; projectFolder?: string};
interface Pending {documentPath: string; sessionId: string; branchName: string; request?: SubmissionRequest}
/** Enable the opt-in Markdown input using the same published call preparation as chat. */
export function createDocumentChatFactory(factory: EditorFactory, services: ApplicationServices, backend: ApplicationBackend,
    prepare: AppUI['prepareChatSubmission'], navigate: (request: NavigationRequest) => Promise<void>): EditorFactory {
    return async (container, options) => {
        const target = options.target;
        if (!prepare || target?.kind !== 'file' || options.contentFormat === 'text' || !/\.(md|mdx|markdown)$/i.test(target.path)) return factory(container, options);
        let documentPath = target.path, editor: IEditor | undefined;
        const supplied = options.defaultPluginOptions?.['interaction:ai-chat'] as {association?: Association; host?: AiChatHost} | undefined;
        if (supplied?.host) return factory(container, options);
        const association = supplied?.association ?? (target.sessionId ? {sessionId: target.sessionId} : undefined);
        const pending = new Map<string, Pending>();
        const host: AiChatHost = {
            listTargets: async ({signal}) => {
                const catalog = await services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets); signal.throwIfAborted();
                return catalog.entries.map(choice => ({kind: choice.target.kind, id: JSON.stringify(choice.target), label: choice.name}));
            },
            onSubmit: async input => {
                const started = Date.now(); let stage = 'validate';
                try {
                    input.signal.throwIfAborted();
                    if (input.source.documentPath !== documentPath) throw failure('DOCUMENT_CHANGED', 'Document changed; reopen the chat input');
                    if (!/^[\w-]{1,128}$/.test(input.operationId)) throw failure('INVALID_OPERATION_ID', 'Invalid chat submission identity');
                    let operation = pending.get(input.operationId);
                    if (operation && operation.documentPath !== documentPath) throw failure('DOCUMENT_CHANGED', 'Submission belongs to another document');
                    if (!operation) {operation = {documentPath, sessionId: input.operationId, branchName: 'chat-' + input.operationId}; pending.set(input.operationId, operation);}
                    if (!operation.request) {
                        stage = 'save-document'; await editor?.flushPendingSave?.(); input.signal.throwIfAborted();
                        stage = 'prepare'; operation.request = await prepareRequest(input, operation, association, options, services, backend, prepare);
                    }
                    stage = 'admission'; await admit(operation.request, services, backend);
                    trace(input.operationId, stage, started);
                    if (!input.signal.aborted) {stage = 'navigate'; await navigate({target: 'chat', resourceId: operation.sessionId});}
                    trace(input.operationId, stage, started); return {branchId: operation.branchName};
                } catch (error) {trace(input.operationId, stage, started, error); throw error;}
            },
        };
        editor = await factory(container, {...options, plugins: [...(options.plugins ?? []), ['interaction:ai-chat', {host}]]});
        const rename = editor.updateNodeId?.bind(editor);
        if (rename) editor.updateNodeId = path => {documentPath = path; rename(path);};
        return editor;
    };
}
async function prepareRequest(input: AiChatSubmitRequest, operation: Pending, association: Association | undefined,
    options: Parameters<EditorFactory>[1], services: ApplicationServices, backend: ApplicationBackend,
    prepare: NonNullable<AppUI['prepareChatSubmission']>): Promise<SubmissionRequest> {
    const catalog = await services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const choice = catalog.entries.find(choice => JSON.stringify(choice.target) === input.target.id && choice.target.kind === input.target.kind);
    if (!choice) throw failure('CALL_TARGET_CHANGED', 'Selected Agent or Flow changed; select it again');
    const files = await attachments(input, options); input.signal.throwIfAborted();
    await backend.createSessionDraft({sessionId: operation.sessionId, branchName: operation.branchName,
        title: operation.documentPath.split('/').pop() ?? 'Chat', inputText: '', inputTarget: choice.target, source: association});
    input.signal.throwIfAborted();
    const assets = await services.sessionRepository.openAttachments(operation.sessionId);
    try {return await prepare({commands: services.commandBus, agents: services.agentService, choice,
        request: requestOf(input, operation, choice), files, assets, signal: input.signal});}
    finally {await assets.dispose();}
}
function requestOf(input: AiChatSubmitRequest, operation: Pending, choice: RootCallTarget): SubmissionRequest {
    const id = input.operationId;
    return {expectedSessionId: operation.sessionId, expectedBranch: operation.branchName,
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
