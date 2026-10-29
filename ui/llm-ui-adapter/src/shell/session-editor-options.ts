import type {EditorOptions} from '@itookit/ui-common';
import type {ISessionRepository, SessionViewPort, ICommandBus} from '@itookit/llm-session/contracts';
import type {IAgentConfigService} from '@itookit/kernel-adapters/contracts';
import type {EditorTaskControlPlane} from '@itookit/durable-kernel/contracts';
import type {IPrivilegedCommandService} from '../domain/ports/IPrivilegedCommandService';
import type {WorkspaceHandoff} from './drafts/workspace-handoff';
import type {SessionLoadMetrics} from './load-metrics';

export interface LLMEditorOptions extends EditorOptions<import('@itookit/llm-flow/contracts').SessionSubmission, import('../services/SessionService').SessionLoadResult> {
    handoff?: WorkspaceHandoff;
    readTaskAttachment?: import('@itookit/durable-kernel/contracts').ReadTaskAttachment;
    configuration?: import('@itookit/kernel-adapters/contracts').ChatConfigurationView;
    sessionId: string;
    sessionRepository: ISessionRepository;
    sessionManager: SessionViewPort;
    defaultHarnessToolIds?: readonly string[];
    agentService: IAgentConfigService;
    initialInputState?: { text?: string; agentId?: string };
    /** Host-owned OCR capability and configuration. */
    ocr?: import('@itookit/ui-common').OcrControls;
    /**
     * Conversation command bus returned by initializeConversationSystem().
     * High-level operations use the injected Session and VCS commands.
     */
    commandBus?: ICommandBus;
    /** Host task control and restoration port. */
    kernel?: EditorTaskControlPlane;
    /** Application service for durable privileged slash commands. */
    privilegedCommands?: IPrivilegedCommandService;
    sessionSkills?: import('@itookit/tools/contracts').SessionSkillControls;
    onLoadMetrics?: (metrics: SessionLoadMetrics) => void;
}
