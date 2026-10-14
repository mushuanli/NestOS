import { initApp, type ApplicationDraftStore } from '@itookit/app-shell/application';
import { WORKSPACES } from 'mind-os/workspaces';
import { HttpApplicationPort } from './application-port';

function clientIdentity(): string {
    const key = 'mindos:application-client';
    const previous = sessionStorage.getItem(key); if (previous) return previous;
    const identity = crypto.randomUUID(); sessionStorage.setItem(key, identity); return identity;
}
export async function startApplicationClient(onProgress: (message: string) => void) {
    const identity = clientIdentity(), application = new HttpApplicationPort('/api/application', globalThis.fetch.bind(globalThis), identity);
    const drafts: ApplicationDraftStore = {
        read: id => { const raw = sessionStorage.getItem(`mindos:draft:${identity}:${id}`); return raw ? JSON.parse(raw) : undefined; },
        write: (id, draft) => { sessionStorage.setItem(`mindos:draft:${identity}:${id}`, JSON.stringify(draft)); },
    };
    return initApp({ application, drafts, workspaces: WORKSPACES, defaultSlug: 'chat', onProgress, presentation: {
        file: async (container, options) => (await import('@itookit/mdx-adapter')).defaultEditorFactory(container, {
            ...options, files: undefined, plugins: ['-ui:asset-manager'],
        }),
        conversation: async (container, controls, options) => (await import('@itookit/llm-ui/conversation')).createConversationEditor(container, controls, options),
    } });
}
