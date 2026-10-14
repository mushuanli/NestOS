// @file: llm-ui/utils/domInsertion.ts

/**
 * Insert an element before a descendant of `container` matching `wrapperSelector`.
 * Falls back to inserting at the start of `container` if no wrapper found.
 */
export function insertBeforeWrapper(
    container: HTMLElement,
    element: HTMLElement,
    wrapperSelector: string,
): void {
    const wrapper = container.querySelector(wrapperSelector);
    const parent = wrapper?.parentElement ?? container;
    parent.insertBefore(element, wrapper ?? parent.firstChild);
}
