// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ENTITY_ICONS, FEEDBACK_ICONS, t } from '@itookit/common';
import { initialState } from '../../../tests/helpers/sync';
import { projectSyncIndicator, syncIndicatorDescription } from '../src/projects/sync/presentation';
import { ProjectSyncStatusIndicator, projectSyncIcon } from '../src/projects/sync/indicator';
import { ProjectNavigation } from '../src/projects/ProjectNavigation';
import type { VFSNodeUI } from '@itookit/vfs-ui';

afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks();});
it('identifies configured sync without implying that the server has been probed', () => {
    const value = projectSyncIndicator(initialState(), {connection: {reason: 'ready', connectionName: 'Office'}})!;
    expect(value.state).toBe('configured'); expect(value.issues).toEqual([]);
    expect(syncIndicatorDescription(value)).toContain('Office: p');
    const detached = initialState(); detached.binding.state = 'detached';
    expect(projectSyncIndicator(detached, {})).toBeUndefined(); expect(projectSyncIndicator(null, {})).toBeUndefined();
});
it('lists missing MCP, incomplete setup, unknown operations, plan and conflict issues together', () => {
    const state = initialState(); state.setupPending = true; state.activePlanId = 'plan';
    state.pending = {terminalExpired: true, command: {target: 'publish', body: {operationId: 'op', opSeq: '1', replicaId: 'r', authorityId: 'a', historyEpoch: 'e'}}};
    state.ackError = {code: 'SYNC_ACK_FAILED'};
    const value = projectSyncIndicator(state, {connection: {reason: 'mcp-not-found'}, conflicts: 2})!;
    expect(value.state).toBe('error'); expect(value.issues).toHaveLength(6);
    expect(value.issues).toContain(t('project.sync.issue.connectionMissing'));
    state.binding.state = 'detached'; expect(projectSyncIndicator(state, {})?.issues).toContain(t('project.sync.issue.detached'));
});
it('keeps local status read errors distinct from an unconfigured project', () => {
    const value = projectSyncIndicator(undefined, {readError: 'control unavailable'})!;
    expect(value.state).toBe('error'); expect(value.issues[0]).toContain('control unavailable');
});
it('opens a safe issue list on hover or focus and opens the selected project status on click', () => {
    const value = projectSyncIndicator(initialState(), {connection: {reason: 'endpoint-mismatch', connectionName: '<script>Office</script>'}})!;
    const opened = vi.fn(), widget = new ProjectSyncStatusIndicator(opened); document.body.append(widget.element); widget.update(value);
    const tooltip = widget.element.querySelector<HTMLElement>('[role="tooltip"]')!, button = widget.element.querySelector('button')!;
    expect(tooltip.hidden).toBe(true); widget.element.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tooltip.hidden).toBe(false); expect(tooltip.querySelectorAll('li')).toHaveLength(1); expect(tooltip.querySelector('script')).toBeNull();
    widget.element.dispatchEvent(new MouseEvent('mouseleave')); expect(tooltip.hidden).toBe(true);
    button.focus(); expect(tooltip.hidden).toBe(false); expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
    button.click(); expect(opened).toHaveBeenCalledOnce(); widget.update(); expect(widget.element.hidden).toBe(true);
    const host = document.createElement('span'); host.innerHTML = projectSyncIcon(false, value);
    expect(host.textContent).toContain(ENTITY_ICONS.sync); expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('[title]')?.getAttribute('title')).toContain('<script>Office</script>');
});
it('decorates only project icons and immediately updates project selector labels after status loads', () => {
    const project = {path: '/Notes', name: 'Notes', project: {id: 'local'}}, selectStatus = vi.fn(async () => {}), refreshList = vi.fn();
    let value = projectSyncIndicator(initialState(), {connection: {reason: 'ready'}});
    const navigation = new ProjectNavigation({} as never, () => ({refreshList}) as never, {
        createProject: vi.fn(), createSession: vi.fn(), createChild: vi.fn(), importItems: vi.fn(), exportItems: vi.fn(),
        report: vi.fn(), retryDeletions: vi.fn(), contentChanged: vi.fn(), syncIndicator: () => value, syncStatus: selectStatus});
    const privateView = navigation as unknown as {project: typeof project; updateHeader(projects: typeof project[], pending: number): void};
    privateView.project = project; privateView.updateHeader([project], 0);
    const projectNode = {id: '/folder:Notes', icon: ENTITY_ICONS.project, metadata: {title: 'Notes', custom: {projectId: 'local'}}} as unknown as VFSNodeUI;
    const rootNode = {...projectNode, id: '/folder:Other', icon: 'folder', metadata: {title: 'Other', custom: {}}};
    privateView.project = undefined as never;
    expect(navigation.navigationItems([projectNode, rootNode])[0].icon).toContain('project-sync-icon');
    expect(navigation.navigationItems([projectNode, rootNode])[1].icon).toBe('folder');
    privateView.project = project;
    value = projectSyncIndicator(initialState(), {connection: {reason: 'mcp-not-found'}}); navigation.refreshSyncIndicators();
    expect(navigation.header.querySelector('select')?.textContent).toContain('Notes ' + FEEDBACK_ICONS.warning);
    expect(navigation.header.querySelector('[role="tooltip"]')?.textContent).toContain(t('project.sync.issue.connectionMissing'));
    navigation.header.querySelector<HTMLButtonElement>('.project-sync-status__button')!.click();
    expect(selectStatus).toHaveBeenCalledWith('local'); expect(refreshList).toHaveBeenCalled(); navigation.destroy();
});
