import { harnessPresentation } from '@itookit/common';

export function mountConversationSource(container: HTMLElement, kind: string, label?: string): void {
    const source = harnessPresentation(kind), badge = document.createElement('span');
    badge.className = 'llm-workspace-titlebar__source'; badge.dataset.conversationSource = kind;
    badge.title = label ?? source.label; badge.setAttribute('aria-label', badge.title);
    const icon = document.createElement('span'); icon.innerHTML = source.icon; icon.setAttribute('aria-hidden', 'true');
    badge.append(icon, document.createTextNode(label ?? source.label));
    container.querySelector('.llm-workspace-titlebar__left')?.after(badge);
}
