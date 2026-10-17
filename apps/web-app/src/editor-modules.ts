let chatModule: ReturnType<typeof importChat> | undefined;
const importChat = () => import('@itookit/llm-ui/chat');
export const loadChatEditor = () => chatModule ??= importChat();

/** Only the editor selected by the current route is fetched before shell assembly. */
export async function preloadBrowserEditor(type?: string): Promise<void> {
    if (type === 'chat' || type === 'flows') await loadChatEditor();
}
