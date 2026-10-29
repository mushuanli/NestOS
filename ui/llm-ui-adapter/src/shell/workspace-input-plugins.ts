import type {ComposerDraft, InputPlugin, InputPluginContext} from '@itookit/llm-ui';
import type {InputPlugin as WorkspacePlugin} from '../components/input/plugins/InputPlugin';
import {HistoryPlugin} from '../components/input/plugins/HistoryPlugin';
import {MentionPlugin} from '../components/input/plugins/MentionPlugin';
import {resourceSuggestions} from '../flows/resource-suggestions';
import type {ICommandBus, PromptHistoryPort} from '@itookit/llm-session/contracts';
import type {ResourceScope} from '@itookit/app-contracts';

/** Existing host plugins consume the shared editing context without owning another input view. */
export function workspaceInputPlugins(commands: ICommandBus | undefined, scope: ResourceScope, agent: () => string,
    history?: PromptHistoryPort): InputPlugin<InputPluginContext, ComposerDraft>[] {
    const plugins: WorkspacePlugin[] = [];
    if (history) plugins.push(new HistoryPlugin(history));
    if (commands) plugins.push(new MentionPlugin({onRequestFiles: (query, options) => resourceSuggestions(commands, scope, query, true, options)}));
    return plugins.map(plugin => ({id: plugin.id, priority: plugin.priority,
        activate: context => plugin.activate({...context, getAgentId: agent}), deactivate: () => plugin.deactivate(),
        setActive: active => plugin.setActive?.(active), onKeyDown: event => plugin.onKeyDown?.(event) ?? false,
        onInput: (text, cursor) => plugin.onInput?.(text, cursor), onBeforeSend: text => plugin.onBeforeSend?.(text),
        onAfterSend: (text, draft) => plugin.onAfterSend?.(text, draft.target?.kind === 'agent' ? draft.target.id : agent()),
        onFocus: () => plugin.onFocus?.(), onBlur: () => plugin.onBlur?.()}));
}
