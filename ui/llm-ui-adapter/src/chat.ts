import {IndependentSessionEditor} from './shell/IndependentSessionEditor';
import {ChatDraftEditor} from './shell/drafts/ChatDraftEditor';
import {createConversationEditor} from './conversation';
import type {RetainedWorkspaceHandoff} from './shell/drafts/workspace-handoff';
import { normalizeEditorOptions } from '@itookit/ui-common';
// @file: llm-ui/index.ts

import './styles/index.css';

import type { LLMEditorOptions } from './shell/session-editor-options';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { IAgentConfigService } from '@itookit/kernel-adapters/contracts';
import { IEditor } from '@itookit/ui-common';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { EditorFactory, EditorOptions } from '@itookit/ui-common';
import type { EditorTaskControlPlane } from '@itookit/durable-kernel/contracts';

export type {
    IPrivilegedCommandService,
    PlanCommandRequest,
    ExecCommandRequest,
} from './domain/ports/IPrivilegedCommandService';

export { DagWorkbench } from './components/DagWorkbench';
export type { DagWorkbenchOptions } from './components/DagWorkbench';
export { FlowsEditor, createFlowsEditorFactory } from './components/FlowsEditor';
export type { FlowsEditorDeps } from './components/FlowsEditor';


/**
 * 创建 LLM 编辑器工厂
 * @param agentService 已初始化的 AgentService
 *
 * @example 动态创建带初始状态的会话
 * ```ts
 * const factory = createLLMFactory(agentService, { sessionRepository, sessionManager });
 * const editor = await factory(container, {
 *     title: 'New Chat',
 *     fs: chatModuleFS
 * });
 * ```
 */
/** A formal Session factory must receive one explicit instance source. */
export type SessionViewBinding =
    | { sessionManager: import('@itookit/llm-session/contracts').SessionViewPort; resolveSessionView?: never }
    | { sessionManager?: never; resolveSessionView: () => import('@itookit/llm-session/contracts').SessionViewPort };

export type LLMFactoryDependencies = SessionViewBinding & {
    defaultHarnessToolIds?: readonly string[];
    sessionRepository: ISessionRepository;
    ocr?: import('@itookit/ui-common').OcrControls;
    commandBus?: ICommandBus;
    kernel?: EditorTaskControlPlane;
    readTaskAttachment?: import('@itookit/durable-kernel/contracts').ReadTaskAttachment;
    privilegedCommands?: import('./domain/ports/IPrivilegedCommandService').IPrivilegedCommandService;
    sessionSkills?: import('@itookit/tools/contracts').SessionSkillControls;
    configuration?: import('@itookit/kernel-adapters/contracts').ChatConfigurationView;
    onLoadMetrics?: LLMEditorOptions['onLoadMetrics'];
};

export const createLLMFactory = (
    agentService: IAgentConfigService,
    deps: LLMFactoryDependencies,
): EditorFactory => {

    // 跟踪进行中的创建，按 sessionId 去重
    // 防止外部框架在短时间内对同一 sessionId 重复调用 factory
    const pendingByContainer = new WeakMap<HTMLElement, Map<string, Promise<IEditor>>>();

    const createEditor = async (container: HTMLElement, options: EditorOptions, handoff?: RetainedWorkspaceHandoff): Promise<IEditor> => {
        const chatOptions = normalizeEditorOptions(options as EditorOptions<import('@itookit/llm-flow/contracts').SessionSubmission, import('./services/SessionService').SessionLoadResult>);
        if (options.conversation) {
            return createConversationEditor(container, options.conversation, options, handoff, deps.ocr);
        }
        if (options.sessionDraft) {
            const editor = new ChatDraftEditor(container, agentService, chatOptions, createEditor,
                {commands: deps.commandBus, configuration: deps.configuration, ocr: deps.ocr});
            try {await editor.init(container); return editor;} catch (error) {try {await editor.destroy();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Draft initialization and cleanup failed');} throw error;}
        }
        let pendingCreations = pendingByContainer.get(container);
        if (!pendingCreations) { pendingCreations = new Map(); pendingByContainer.set(container, pendingCreations); }
        if (options.target?.kind !== 'session') throw new Error('Chat editor requires a Session target');
        const sessionId = options.target.sessionId;
        const engine = deps.sessionRepository;

        // 去重：如果同一个 sessionId 正在创建中，等待并复用
        if (sessionId && pendingCreations.has(sessionId)) {
            try {
                return await pendingCreations.get(sessionId)!;
            } catch {
                // 前一次创建失败了，继续创建新的
                pendingCreations.delete(sessionId);
            }
        }

        const sessionManager = deps.sessionManager ?? deps.resolveSessionView?.();
        if (!sessionManager) throw new Error('Chat editor requires an injected session view');
        const editorOptions: LLMEditorOptions = {
            ...chatOptions,
            agentService,
            sessionId,
            sessionRepository: engine,
            sessionManager,
            defaultHarnessToolIds: deps.defaultHarnessToolIds,
            ocr: deps.ocr,
            commandBus: deps.commandBus,
            kernel: deps.kernel,
            readTaskAttachment: deps.readTaskAttachment,
            privilegedCommands: deps.privilegedCommands,
            sessionSkills: deps.sessionSkills,
            configuration: deps.configuration,
            onLoadMetrics: deps.onLoadMetrics,
        };

        // 将创建过程包装为 Promise，注册到 pendingCreations
        const createPromise = (async () => {
            let editor: IEditor | undefined;
            try {
                editor = new IndependentSessionEditor(container, editorOptions, handoff);
                await editor.init(container, options.initialContent);
                return editor;
            } catch (e) {
                try { await editor?.destroy(); }
                catch (cleanupError) { throw new AggregateError([e, cleanupError], 'Editor initialization and cleanup failed'); }
                throw e;
            } finally {
                // 无论成功失败，都清理 pending 记录
                if (sessionId) {
                    pendingCreations.delete(sessionId);
                }
            }
        })();

        if (sessionId) {
            pendingCreations.set(sessionId, createPromise);
        }

        return createPromise;
    };
    return createEditor;
};

export type { LLMEditorOptions };

// AI 右键菜单扩展
export { createAIContextMenuConfig } from './context-menu/AIContextMenu';
export type { AIContextMenuOptions } from './context-menu/AIContextMenu';

export { createFlowContextMenuConfig } from './flows/context-menu';
export { FlowLauncher, type FlowRunOptions, type FlowRunInput } from './flows/run-flow';
export { restoreFlowLibrary } from './flows/library';


export type { FlowContextMenuOptions } from './flows/context-menu';
