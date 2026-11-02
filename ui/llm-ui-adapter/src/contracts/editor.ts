import type {EditorOptions as HostEditorOptions} from '@itookit/ui-common-adapter';
import type {ConversationControls, RemoteAgentControls} from './ConversationControls';
import type {SessionDraftControls} from './SessionDraftControls';

/** NestOS conversation wiring extends the resource-neutral editor host contract. */
export interface ChatEditorOptions<TSubmission = unknown, TInitial = unknown> extends HostEditorOptions<TSubmission, TInitial> {
    conversation?: ConversationControls;
    remoteAgents?: RemoteAgentControls;
    /** A project draft remains separate from history until its first accepted submission. */
    sessionDraft?: SessionDraftControls<TSubmission>;
}
export type EditorOptions<TSubmission = unknown, TInitial = unknown> = ChatEditorOptions<TSubmission, TInitial>;

export type ChatEditorFactory = (container: HTMLElement, options: ChatEditorOptions) => Promise<import('@itookit/ui-common-adapter').IEditor>;
