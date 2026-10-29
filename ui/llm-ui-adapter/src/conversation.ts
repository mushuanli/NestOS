import {IndependentConversationEditor} from './shell/IndependentConversationEditor';
import {NativeChatStore} from './independent/native-store';
import {createModuleLogger} from '@itookit/common';
import type { ConversationControls, EditorOptions, IEditor } from '@itookit/ui-common';
import type {WorkspaceHandoff, RetainedWorkspaceHandoff} from './shell/drafts/workspace-handoff';

/** A presentation factory independent of the execution location. */
export async function createConversationEditor(container: HTMLElement, controls: ConversationControls, options: EditorOptions, handoff?: WorkspaceHandoff | RetainedWorkspaceHandoff, ocr?: import('@itookit/ui-common').OcrControls): Promise<IEditor> {
    let editor: IEditor | undefined;
    try {
        const retained = handoff && 'kind' in handoff ? handoff : undefined;
        const store = NativeChatStore.supported(controls) ? await NativeChatStore.open(controls, retained?.conversationId) : undefined;
        if (retained && !store) throw Object.assign(new Error('Native host must support durable drafts to adopt a ChatView'), {code: 'NATIVE_DRAFT_PORT_REQUIRED'});
        if (store && (!handoff || retained)) editor = new IndependentConversationEditor(container, controls, options, store, retained, ocr);
        else {
            const {RemoteConversationEditor} = await import('./shell/RemoteConversationEditor');
            editor = new RemoteConversationEditor(container, controls, options, handoff && !('kind' in handoff) ? handoff : undefined);
        }
        if (!store) createModuleLogger('conversation-factory').info('chat.compatibility', {stage: 'select', result: 'success',
            reason: NativeChatStore.supported(controls) ? 'LEGACY_SUBMISSION_RECOVERY' : 'LEGACY_HOST_DRAFT_PORTS'});
        await editor.init(container); return editor;
    } catch (error) {
        try {if (editor) await editor.destroy(); else await controls.close();}
        catch (cleanup) {throw new AggregateError([error, cleanup], 'Conversation initialization failed');}
        throw error;
    }
}
