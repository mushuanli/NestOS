import { folderBrowserPath } from '@itookit/app-contracts';
import type { ProjectService } from '@itookit/app-contracts/services';
import { t } from '@itookit/common';

/** Decode the shell envelope once; folder segments keep their own URI encoding. */
export function parseWorkspaceHash(hash: string, fallback: string): { slug: string; resource?: string } {
    const [slug, ...segments] = hash.replace(/^#\/?/, '').split('/');
    const raw = segments.join('/');
    let resource = raw;
    try { resource = decodeURIComponent(raw); } catch { /* Let the workbench report a malformed address. */ }
    return { slug: (slug === 'minds' ? 'notes' : slug) || fallback, resource: resource && resource !== 'new' ? resource : undefined };
}

/** Old .prj files stay in their original filesystem and are exposed as project files. */
export async function resolveLegacyProjectResource(resource: string, projects: ProjectService): Promise<string> {
    const project = await projects.ensureDirectory('/home/admin/projects', t('project.legacyDocuments'));
    return `${folderBrowserPath(project.path)}/@files${resource.startsWith('/') ? resource : '/' + resource}`;
}
