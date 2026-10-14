/** Identify the nearest history group without any conversation execution dependency. */
export function visibleSessionId(history: HTMLElement): string | undefined {
    const rect = history.getBoundingClientRect(), line = rect.top + rect.height * .4;
    let closest: HTMLElement | undefined, distance = Infinity;
    for (const session of history.querySelectorAll<HTMLElement>('.llm-ui-session')) {
        const bounds = session.getBoundingClientRect();
        if (bounds.top <= line && bounds.bottom >= line) return session.dataset.sessionId;
        const next = Math.abs(bounds.top + bounds.height / 2 - line);
        if (next < distance) { closest = session; distance = next; }
    }
    return closest?.dataset.sessionId;
}
