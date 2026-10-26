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

/** Keep the original MDx editors and bind embedded inputs to their persisted message. */
export function workspaceMessagePlugins(options: EditorOptions, branch: () => string | undefined) {
    const configured = options.defaultPluginOptions?.['interaction:ai-chat'] as {
        createHost?(source: MessageSource): AiChatHost;
    } | undefined;
    const target = options.target;
    if (!configured?.createHost || target?.kind !== 'session') return;
    return (source: {messageId: string; role: string; roundId?: string}) => {
        const documentPath = `session:${target.sessionId}/messages/${encodeURIComponent(source.messageId)}`;
        const host = configured.createHost!({...source, documentPath, branch: branch()});
        const bound: AiChatHost = {
            listTargets: context => host.listTargets({...context, source: {...context.source, documentPath}}),
            onSubmit: request => host.onSubmit({...request, source: {...request.source, documentPath}}),
        };
        if (host.getDefaultTarget) bound.getDefaultTarget = context => host.getDefaultTarget!({...context, source: {...context.source, documentPath}});
        if (host.pickAttachments) bound.pickAttachments = context => host.pickAttachments!({...context, source: {...context.source, documentPath}});
        log.debug('message.markdown', {sessionId: target.sessionId, messageId: source.messageId,
            stage: 'workspace-plugin-install', result: 'success', plugin: 'interaction:ai-chat'});
        return [new AiChatPlugin({host: bound})];
    };
}
