import { resolveBrowserTarget, projectRelativePath, type TwinSelectionTarget } from '@itookit/app-contracts';
import type { DigitalTwinService, ProjectService } from '@itookit/app-contracts/services';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import type { MenuItem } from '@itookit/ui-common';
import { showTwinSource } from './source-dialog';
import { label } from './view';

export function twinSourceMenu(service: DigitalTwinService, target: () => Promise<TwinSelectionTarget | undefined>, settings: () => Promise<void>, signal?: AbortSignal): MenuItem<VFSNodeUI>[] {
    return [{ id: 'twin-analysis', label: label('documentAnalysis'), onClick: async () => {
        const source = await target(); if (source && !signal?.aborted) showTwinSource(service, source, settings, signal);
    } }];
}
export async function projectTwinTarget(projects: ProjectService, node: VFSNodeUI): Promise<TwinSelectionTarget | undefined> {
    const route = resolveBrowserTarget(node.id), label = node.metadata.title || node.id;
    if (route.kind === 'session') return { kind: 'session', target: route.sessionId, label };
    if (route.kind !== 'project-files' && route.kind !== 'remote' && route.kind !== 'folder') return;
    const folder = route.kind === 'folder' ? undefined : route.folder;
    const project = route.kind === 'folder' ? (await projects.list()).find(item => item.project.id === node.metadata.custom.projectId) : await projects.forFolder(folder!);
    if (!project) return;
    if (route.kind === 'remote') return route.profileId && route.nativeSessionId ? { kind: 'harness-session', label,
        target: JSON.stringify([project.project.id, route.profileId, route.nativeSessionId]) } : undefined;
    const path = route.kind === 'folder' ? '/' : projectRelativePath(route.path);
    return { kind: 'file', target: `project://${encodeURIComponent(project.project.id)}/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
        directory: route.kind === 'folder' || node.type === 'directory', label };
}
