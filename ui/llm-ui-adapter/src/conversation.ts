import type { ConversationControls, EditorOptions, IEditor } from '@itookit/ui-common';
import {NativeChatStore} from './independent/native-store';
import {IndependentConversationEditor} from './shell/IndependentConversationEditor';
import type {WorkspaceHandoff} from './shell/drafts/workspace-handoff';
import { RemoteConversationEditor } from './shell/RemoteConversationEditor';

/** A presentation factory independent of the execution location. */
export async function createConversationEditor(container: HTMLElement, controls: ConversationControls, options: EditorOptions, handoff?: WorkspaceHandoff): Promise<IEditor> {
    if (!handoff && !options.readOnly && NativeChatStore.supported(controls)) {
        const snapshot = await controls.read();
        if (snapshot.sessionId) {
            const store = await NativeChatStore.open(controls);
            if (store) {
                const editor = new IndependentConversationEditor(container, controls, options, store);
                try {await editor.init(container); return editor;}
                catch (error) {try {await editor.destroy();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Conversation initialization failed');} throw error;}
            }
        }
    }
    const editor = new RemoteConversationEditor(container, controls, options, handoff);
    try { await editor.init(container); return editor; } catch (error) { try {await editor.destroy();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Conversation initialization failed');} throw error; }
}
