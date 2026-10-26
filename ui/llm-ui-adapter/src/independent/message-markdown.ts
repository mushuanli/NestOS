import {AiChatPlugin, type AiChatHost} from '@itookit/mdxeditor';
import {createModuleLogger} from '@itookit/common';
import type {ChatOptions} from '@itookit/llm-ui';
import type {EditorOptions} from '@itookit/ui-common';

interface MessageSource {documentPath: string; messageId: string; role: string; branch?: string; roundId?: string; userIndex?: number}
const log = createModuleLogger('message-markdown');
/** The host binds message identity; Markdown text cannot register plugins or choose an execution owner. */
export function messageMarkdown(options: EditorOptions, anchor?: (messageId: string) => {branch: string; roundId?: string; userIndex?: number} | undefined): ChatOptions['markdown'] {
    const configured = options.defaultPluginOptions?.['interaction:ai-chat'] as {
        createHost?(source: MessageSource): AiChatHost;
    } | undefined;
    if (!configured?.createHost) return;
    const target = options.target;
    if (target?.kind !== 'session') return;
    const base = `session:${target.sessionId}`;
    return (context, part) => {
        if (part.kind !== 'markdown' || !['user', 'assistant'].includes(context.message.role)) return {};
        const documentPath = `${base}/messages/${encodeURIComponent(context.message.id)}/${encodeURIComponent(part.id)}`;
        const host = configured.createHost!({documentPath, messageId: context.message.id, role: context.message.role, ...anchor?.(context.message.id)});
        log.debug('message.markdown', {sessionId: target.sessionId, messageId: context.message.id, partId: part.id,
            stage: 'plugin-install', result: 'success', plugin: 'interaction:ai-chat'});
        return {documentPath, plugins: [new AiChatPlugin({host})]};
    };
}
