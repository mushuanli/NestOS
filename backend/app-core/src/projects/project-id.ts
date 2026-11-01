import {FSError} from '@itookit/vfs-core';

/** Human-readable project IDs are scoped to one project catalog. */
export function validateProjectId(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new FSError('EINVAL', 'Project ID must contain 1–64 letters, digits, hyphens or underscores and start with a letter or digit');
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new FSError('EINVAL', 'Use a readable project ID instead of a UUID');
    return id;
}
export function allocateProjectId(name: string, existing: readonly string[], requested?: string): string {
    const used = new Set(existing.map(id => id.toLowerCase()));
    if (requested !== undefined) {
        const id = validateProjectId(requested);
        if (used.has(id.toLowerCase())) throw new FSError('EEXIST', 'Project ID already exists');
        return id;
    }
    const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
    const base = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(slug) ? 'project' : slug;
    let id = base;
    for (let suffix = 2; used.has(id.toLowerCase()); suffix++) id = `${base}-${suffix}`;
    return id;
}
