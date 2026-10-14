/** Keep nested initialization failures visible without allowing cyclic causes to loop. */
export function errorDetails(value: unknown): string {
    const seen = new Set<unknown>();
    const lines: string[] = [];
    const visit = (error: unknown, depth: number): void => {
        if (lines.length >= 32 || depth > 8) return;
        const indent = '  '.repeat(depth);
        if (error instanceof Error) {
            if (seen.has(error)) return;
            seen.add(error);
            lines.push(`${indent}${error.name}: ${error.message}`);
            if (error instanceof AggregateError) for (const child of error.errors) visit(child, depth + 1);
            if (error.cause !== undefined) visit(error.cause, depth + 1);
        } else {
            try { lines.push(indent + (typeof error === 'string' ? error : JSON.stringify(error) ?? String(error))); }
            catch { lines.push(indent + String(error)); }
        }
    };
    visit(value, 0);
    return lines.join('\n');
}
