import type { SessionSummary } from '@itookit/llm-session';

/** A damaged relation remains reachable as a root instead of disappearing from navigation. */
export function sessionFamilyRoots(sessions: SessionSummary[]): Map<string, string> {
    const byId = new Map(sessions.map(item => [item.id, item]));
    const roots = new Map<string, string>();
    for (const session of sessions) {
        const path: string[] = [];
        let current = session;
        while (!roots.has(current.id) && !path.includes(current.id)) {
            path.push(current.id);
            const parent = current.parentSessionId ? byId.get(current.parentSessionId) : undefined;
            if (!parent || (parent.folder ?? null) !== (current.folder ?? null)) break;
            current = parent;
        }
        const cycle = path.indexOf(current.id);
        const root = roots.get(current.id) ?? (cycle >= 0 && current.parentSessionId && path.includes(current.parentSessionId)
            ? path.slice(cycle).sort()[0]! : current.id);
        for (const id of path) roots.set(id, root);
    }
    return roots;
}
