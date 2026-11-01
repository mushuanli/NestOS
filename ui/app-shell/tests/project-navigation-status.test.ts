// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import type {RemoteProjectStatus} from '@itookit/app-contracts/services';
import {ProjectNavigation} from '../src/projects/ProjectNavigation';

afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks();});

it('keeps sidebar actions as icons while exposing busy files without disabling new drafts', async () => {
    const project = {path: '/Remote', name: 'Remote', project: {id: 'remote'}}, projectStatus = vi.fn(), createSession = vi.fn();
    let changed: (() => void) | undefined;
    const state: RemoteProjectStatus = {projectId: 'remote', status: 'degraded', problem: 'files-busy', mounts: [
        {mountId: 'root', status: 'online', failure: {id: 'failure', timestamp: 1, operationId: 'probe', module: 'cells',
            operation: 'remote.operation', stage: 'root-probe', result: 'failure', level: 'error', code: 'EBUSY', reason: 'busy'}}]};
    const readStatus = vi.fn(async () => state), remote = {list: () => [{at: '/', access: 'rw'}], projectOffline: () => false,
        onChange: (listener: () => void) => {changed = listener; return () => {};}, projectStatus: readStatus};
    const navigation = new ProjectNavigation({remoteMounts: remote, navigation: async () => ({project, projects: [project], path: '/', offlineProjectIds: [], pendingDeletions: 0, loadPaths: []})} as never,
        () => undefined, {createProject: vi.fn(), createSession, createChild: vi.fn(), importItems: vi.fn(), exportItems: vi.fn(),
            report: vi.fn(), retryDeletions: vi.fn(), contentChanged: vi.fn(), projectStatus, projectSettings: projectStatus});
    document.body.append(navigation.header);
    try {
        await navigation.sync('/');
        const status = navigation.header.querySelector<HTMLButtonElement>('[data-project-action="settings"]')!;
        const create = navigation.header.querySelector<HTMLButtonElement>('.workbench-project-navigation__create')!;
        await vi.waitFor(() => expect(status.title).toContain('EBUSY'));
        expect(status.querySelector('.workbench-icon')).not.toBeNull();
        expect(status.textContent).not.toContain(t('diagnostics.problem.files-busy'));
        expect(status.getAttribute('aria-label')).toContain(t('diagnostics.problem.files-busy'));
        expect(status.title).toContain(t('diagnostics.reason.busy'));
        expect(create.children).toHaveLength(1); expect(create.querySelector('svg')).not.toBeNull();
        expect(create.getAttribute('aria-label')).toBe(t('project.createSession')); expect(create.disabled).toBe(false);
        status.click(); await vi.waitFor(() => expect(projectStatus).toHaveBeenCalledWith('remote'));
        create.click(); await vi.waitFor(() => expect(createSession).toHaveBeenCalledWith('/folder:Remote'));
        readStatus.mockRejectedValueOnce(new Error('PRIVATE_ERROR')); changed?.();
        await vi.waitFor(() => expect(status.getAttribute('aria-label')).toBe(t('diagnostics.statusFailed')));
        expect(status.children).toHaveLength(1); expect(status.textContent).not.toContain('PRIVATE_ERROR');
        changed?.(); await vi.waitFor(() => expect(status.title).toContain('EBUSY'));
        expect(navigation.header.querySelector('select')?.value).toBe('/folder:Remote');
    } finally {navigation.destroy();}
});
