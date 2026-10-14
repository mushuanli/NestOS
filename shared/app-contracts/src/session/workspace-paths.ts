/** Single-user application layout, relative to the MindOS filesystem. */
export function workspaceRoot(name: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid workspace identity');
    return `/home/admin/${name}`;
}
