/** Replace selected slots without deleting unselected values or preferring older high scores. */
export function mergeResults<T>(previous: Record<string, T>, updates: Record<string, T>): Record<string, T> {
    return { ...previous, ...updates };
}
