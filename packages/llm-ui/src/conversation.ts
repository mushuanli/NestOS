import type { ConversationControls, EditorOptions, IEditor } from '@itookit/ui-common';
import { RemoteConversationEditor } from './shell/RemoteConversationEditor';

/** A presentation factory independent of the execution location. */
export async function createConversationEditor(container: HTMLElement, controls: ConversationControls, options: EditorOptions): Promise<IEditor> {
    const editor = new RemoteConversationEditor(container, controls, options);
    try { await editor.init(container); return editor; } catch (error) { await editor.destroy(); throw error; }
}
