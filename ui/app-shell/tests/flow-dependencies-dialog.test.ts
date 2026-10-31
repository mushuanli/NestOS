// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {getLogger, t} from '@itookit/common';
import type {FlowInstallationReport} from '@itookit/app-contracts/services';
import {showFlowDependencies} from '../src/configuration/flow-dependencies-dialog';

const controllers: AbortController[] = [], opened: Promise<void>[] = [];
beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {this.open = true;}});
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {this.open = false;}});
});
afterEach(async () => {for (const controller of controllers.splice(0)) controller.abort(); await Promise.all(opened.splice(0)); document.body.replaceChildren(); vi.restoreAllMocks();});
const report: FlowInstallationReport = {flowId: 'selected', name: 'Selected workflow', status: 'missingTools',
    tools: [{id: 'fixture.tool', status: 'missing'}], parameters: [], connections: [], errors: []};
function fixture(check = vi.fn(async () => report)) {
    const controller = new AbortController(); controllers.push(controller);
    const ensure = vi.fn(async () => ({...report, status: 'needsConfiguration' as const, tools: [{id: 'fixture.tool', status: 'ready' as const}],
        connections: [{field: 'vision', code: 'MISSING_CONNECTION', message: 'Choose an image-capable connection'}]}));
    opened.push(showFlowDependencies({check, ensure}, report.flowId, controller.signal));
    const dialog = document.querySelector<HTMLDialogElement>('.flow-dependencies-dialog')!;
    const button = (key: Parameters<typeof t>[0]) => [...dialog.querySelectorAll('button')].find(button => button.textContent === t(key))!;
    return {dialog, check, ensure, controller, button};
}
it('checks only the selected workflow and keeps missing tools separate from connection configuration', async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.dialog.textContent).toContain('fixture.tool'));
    expect(f.check).toHaveBeenCalledWith('selected'); expect(f.ensure).not.toHaveBeenCalled();
    expect(f.dialog.textContent).toContain(t('flow.dependencies.savedHint'));
    const prepare = f.button('flow.dependencies.prepare'); prepare.click(); prepare.click();
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('Choose an image-capable connection'));
    expect(f.ensure).toHaveBeenCalledOnce(); expect(f.ensure).toHaveBeenCalledWith('selected'); expect(prepare.hidden).toBe(true);
    expect(f.dialog.querySelector('footer')!.contains(f.button('action.close'))).toBe(true);
});
it('retains a retry action and logs safe request metadata when reading fails', async () => {
    const check = vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE_RESPONSE'), {code: 'EIO'})).mockResolvedValue(report);
    getLogger().clear(); const f = fixture(check);
    await vi.waitFor(() => expect(f.dialog.textContent).toContain(t('flow.dependencies.readFailed', {code: 'EIO'})));
    expect(f.dialog.textContent).not.toContain('PRIVATE_RESPONSE'); f.button('flow.dependencies.check').click();
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('fixture.tool'));
    const logs = getLogger().query({modules: ['flow-dependencies-ui']});
    expect(logs).toContainEqual(expect.objectContaining({data: expect.objectContaining({operationId: expect.any(String), code: 'EIO', durationMs: expect.any(Number)})}));
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_RESPONSE');
});
it('ignores delayed reports after closing and keeps the origin focus', async () => {
    const origin = document.createElement('button'); document.body.append(origin); origin.focus();
    let finish!: (report: FlowInstallationReport) => void;
    const f = fixture(vi.fn(() => new Promise<FlowInstallationReport>(resolve => {finish = resolve;})));
    f.button('action.close').click(); finish(report); await Promise.all(opened);
    expect(document.querySelector('.flow-dependencies-dialog')).toBeNull(); expect(document.activeElement).toBe(origin);
});
it('explains internal-only definitions without offering tool preparation for a visibility restriction', async () => {
    const f = fixture(vi.fn(async () => ({...report, status: 'needsConfiguration', tools: [],
        connections: [{code: 'CALLABLE_LOCAL_ONLY', message: 'Local definitions can only be called inside a Flow'}]})));
    await vi.waitFor(() => expect(f.dialog.textContent).toContain(t('flow.dependencies.localOnly')));
    expect(f.dialog.textContent).not.toContain('Local definitions can only'); expect(f.button('flow.dependencies.prepare').hidden).toBe(true);
});

it('keeps navigation failures actionable and allows retrying tool management', async () => {
    const controller = new AbortController(); controllers.push(controller);
    const manage = vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE_ROUTE'), {code: 'EIO'})).mockResolvedValue(undefined);
    opened.push(showFlowDependencies({check: async () => report, ensure: vi.fn()}, report.flowId, controller.signal, manage));
    const dialog = document.querySelector<HTMLDialogElement>('.flow-dependencies-dialog')!;
    const button = () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('flow.dependencies.manage'))!;
    await vi.waitFor(() => expect(button().hidden).toBe(false)); button().click();
    await vi.waitFor(() => expect(dialog.textContent).toContain(t('flow.dependencies.manageFailed', {code: 'EIO'})));
    expect(dialog.textContent).not.toContain('PRIVATE_ROUTE'); button().click();
    await vi.waitFor(() => expect(document.querySelector('.flow-dependencies-dialog')).toBeNull()); expect(manage).toHaveBeenCalledTimes(2);
});

it('routes disabled tools to personal package settings instead of repeatedly preparing them', async () => {
    const controller = new AbortController(); controllers.push(controller); const manage = vi.fn(async () => {}), ensure = vi.fn();
    opened.push(showFlowDependencies({check: async () => ({...report, status: 'needsConfiguration',
        tools: [{id: 'fixture.tool', status: 'failed', code: 'TOOL_DISABLED', reason: 'Registered tool is disabled'}]}), ensure}, report.flowId, controller.signal, manage));
    const dialog = document.querySelector('.flow-dependencies-dialog')!;
    await vi.waitFor(() => expect(dialog.textContent).toContain(t('toolbox.packages.toolDisabled')));
    const buttons = [...dialog.querySelectorAll('button')];
    expect(buttons.find(button => button.textContent === t('flow.dependencies.prepare'))!.hidden).toBe(true);
    expect(buttons.find(button => button.textContent === t('flow.dependencies.manage'))!.hidden).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
});
