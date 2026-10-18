import type {ChatInput, ChatInputOptions} from '../../components/input/ChatInputView';

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
