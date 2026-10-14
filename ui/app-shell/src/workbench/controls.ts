/** Icons come from the shared catalog; resource names always use textContent. */
export function decorateButton(button: HTMLButtonElement, icon: string, label: string, iconOnly = false): HTMLButtonElement {
    button.title = label; button.setAttribute('aria-label', label);
    const graphic = document.createElement('span'); graphic.className = 'workbench-icon'; graphic.innerHTML = icon; graphic.setAttribute('aria-hidden', 'true');
    button.replaceChildren(graphic);
    if (!iconOnly) { const text = document.createElement('span'); text.textContent = label; button.append(text); }
    return button;
}

/** Resource graphics share the explorer's light/dark file-type palette. */
export function decorateResourceButton(button: HTMLButtonElement, icon: string, label: string): HTMLButtonElement {
    decorateButton(button, icon, label); button.querySelector('.workbench-icon')!.classList.add('file-type-icon'); return button;
}
