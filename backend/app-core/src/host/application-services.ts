import type { LocalApplicationServices } from '@itookit/app-contracts/services';
import type { ApplicationRuntime } from '../runtime/create-application-runtime';

/** Only the host owns dispose(), recovery and client execution contexts. */
export function bindLocalApplicationServices(runtime: ApplicationRuntime): LocalApplicationServices {
    const { vfs, llmDriver, agentService, configuration, sessionRepository, flowEngine, sessionFiles, flowInstallations, toolPackages,
        directoryMounts, projects, projectSync, digitalTwin, kernel, sessionManager, commandBus } = runtime;
    return { editorSwapStore: runtime.editorSwapStore, vfs, llmDriver, agentService, configuration, sessionRepository, flowEngine, sessionFiles, flowInstallations, toolPackages,
        directoryMounts, projects, projectSync, digitalTwin, kernel, sessionManager, commandBus,
        acquireConversation: id => runtime.openConversation(id),
        prepareSession: async id => {
            const conversation = await runtime.openConversation(id);
            try { return await runtime.prepareSession?.(id) ?? true; } finally { await conversation.dispose(); }
        }, startBackground: runtime.startBackground?.bind(runtime) };
}
