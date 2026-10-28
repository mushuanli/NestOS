import type {ChatInput, ChatInputOptions} from '../../components/input/ChatInputView';
import type {ChatView} from '@itookit/llm-ui';
import type {DraftFilePort} from '../../services/DraftFilesCodec';

/** The project retains ownership until the host has accepted the prepared editor. */
export interface RetainedWorkspaceHandoff {readonly kind: 'chat-view'; readonly view: ChatView; readonly read: DraftFilePort['read']}

/** A controller handoff keeps the visible workspace and composer in place. */
export interface WorkspaceHandoff {
    input: ChatInput;
    prepare(): void;
    release(): void;
    configure(options: ChatInputOptions): ChatInputOptions;
}
export function bindWorkspaceInput(options: ChatInputOptions, handoff: WorkspaceHandoff): ChatInput {
    handoff.input.adopt(handoff.configure(options)); return handoff.input;
}
