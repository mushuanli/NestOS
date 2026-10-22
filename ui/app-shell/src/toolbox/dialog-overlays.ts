/** Keep settings confirmations and toast portals inside the native modal's top layer. */
export function mountDialogOverlays(dialog: HTMLDialogElement): () => void {
    const adopted = new Set<HTMLElement>();
    const adopt = (node: Node) => {
        if (!(node instanceof HTMLElement) || node.parentElement !== document.body) return;
        if (!node.matches('.settings-modal-overlay, .settings-toast-container')) return;
        adopted.add(node); dialog.append(node);
    };
    const observer = new MutationObserver(records => { for (const record of records) record.addedNodes.forEach(adopt); });
    observer.observe(document.body, { childList: true });
    document.body.querySelectorAll(':scope > .settings-toast-container').forEach(adopt);
    return () => {
        observer.disconnect();
        for (const node of adopted) {
            if (!dialog.contains(node)) continue;
            if (node.classList.contains('settings-toast-container')) document.body.append(node);
            else { node.querySelector<HTMLButtonElement>('.settings-modal-cancel')?.click(); node.remove(); }
        }
        adopted.clear();
    };
}
