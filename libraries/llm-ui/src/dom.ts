export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string,
    text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
export function button(label: string, action: () => void): HTMLButtonElement {
    const node = element('button', undefined, label);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
}
export async function disposeAll(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
    const errors: unknown[] = [];
    for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Chat view disposal failed');
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
