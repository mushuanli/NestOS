// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {FlowInstallationReport, FlowInstallations, ToolPackageInfo, ToolPackages} from '@itookit/app-contracts/services';
import {showToolPackages} from '../src/toolbox/ToolPackagesDialog';

const opened: Promise<void>[] = [];
afterEach(async () => {
    document.querySelectorAll<HTMLDialogElement>('.tool-packages-dialog').forEach(dialog => dialog.close());
    await Promise.all(opened.splice(0)); document.body.replaceChildren(); vi.restoreAllMocks();
});

function setup(controls: {toolPackages?: ToolPackages; flowInstallations?: FlowInstallations}, signal?: AbortSignal) {
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const changed = vi.fn(async () => {}); opened.push(showToolPackages(controls, signal, changed));
    const dialog = document.querySelector<HTMLDialogElement>('.tool-packages-dialog')!;
    return {dialog, changed};
}

const available: ToolPackageInfo = {id: 'external-package', name: '<img src=x>', version: '1.2.0', status: 'available', tools: [{id: 'document.inspect', version: '2'}]};

it('registers only catalog tool identities, reports the actual result and ignores duplicate clicks', async () => {
    let release!: (value: {tools: Array<{id: string; status: 'ready'}>}) => void;
    const ensure = vi.fn(() => new Promise<{tools: Array<{id: string; status: 'ready'}>}>(resolve => {release = resolve;}));
    let registered = false;
    const list = vi.fn(async () => [{...available, status: registered ? 'registered' as const : 'available' as const}]);
    const f = setup({toolPackages: {list, ensure}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull());
    expect(f.dialog.querySelector('img')).toBeNull(); expect(f.dialog.querySelector('input')).toBeNull();
    const button = f.dialog.querySelector<HTMLButtonElement>('[data-package-ensure]')!; button.click(); button.click();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce()); expect(ensure).toHaveBeenCalledWith(available.tools);
    registered = true; release({tools: [{id: 'document.inspect', status: 'ready'}]});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册'));
    expect(f.changed).toHaveBeenCalledOnce(); expect(f.dialog.querySelector('[data-package-ensure]')).toBeNull();
});

it('shows a missing package reason without advertising an arbitrary installation source', async () => {
    const ensure = vi.fn(), list = vi.fn(async () => [{...available, status: 'missing' as const, reason: 'Package is not installed on this host'}]);
    const f = setup({toolPackages: {list, ensure}});
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('Package is not installed on this host'));
    expect(f.dialog.querySelector('[data-package-ensure]')).toBeNull(); expect(f.dialog.querySelector('input')).toBeNull();
    f.dialog.querySelector<HTMLButtonElement>('[data-packages-refresh]')!.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2)); expect(ensure).not.toHaveBeenCalled();
});

it('keeps missing tools and configuration requirements distinct while retrying Flow dependencies', async () => {
    const report: FlowInstallationReport = {flowId: 'external-flow', name: 'Document workflow', status: 'missingTools', tools: [{id: 'document.inspect', status: 'missing'}], parameters: [], connections: [], errors: []};
    const configured: FlowInstallationReport = {...report, status: 'needsConfiguration', tools: [{id: 'document.inspect', status: 'ready'}], connections: [{code: 'MISSING_CONNECTION', field: 'vision', message: 'Choose an image-capable connection'}]};
    let current = report;
    const ensure = vi.fn(async () => {current = configured; return current;}), check = vi.fn(async () => current);
    const f = setup({flowInstallations: {list: async () => [current], ensure, check}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-flow-check]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-flow-check]')!.click();
    await vi.waitFor(() => expect(check).toHaveBeenCalledWith('external-flow')); expect(ensure).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.dialog.querySelector<HTMLButtonElement>('[data-flow-ensure]')!.disabled).toBe(false));
    f.dialog.querySelector<HTMLButtonElement>('[data-flow-ensure]')!.click();
    await vi.waitFor(() => expect(f.dialog.textContent).toContain('Choose an image-capable connection'));
    expect(f.dialog.textContent).toContain('需要配置'); expect(f.dialog.textContent).not.toContain('依赖已就绪');
    expect(ensure).toHaveBeenCalledWith('external-flow');
});

it('does not resurrect a closed package dialog after a late registration response', async () => {
    let release!: (value: {tools: Array<{id: string; status: 'ready'}>}) => void;
    const ensure = vi.fn(() => new Promise<{tools: Array<{id: string; status: 'ready'}>}>(resolve => {release = resolve;}));
    const controller = new AbortController(), f = setup({toolPackages: {list: async () => [available], ensure}}, controller.signal);
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-package-ensure]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>('[data-package-ensure]')!.click();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce()); controller.abort(); release({tools: [{id: 'document.inspect', status: 'ready'}]});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('.tool-packages-dialog')).toBeNull(); expect(f.changed).not.toHaveBeenCalled();
});

it.each(['package', 'flow'])('refreshes both package and Flow states after preparing the %s', async target => {
    let registered = false;
    const report = (): FlowInstallationReport => ({flowId: 'external-flow', name: 'Document workflow', status: registered ? 'ready' : 'missingTools',
        tools: [{id: 'document.inspect', status: registered ? 'ready' : 'missing'}], parameters: [], connections: [], errors: []});
    const listPackages = vi.fn(async () => [{...available, status: registered ? 'registered' as const : 'available' as const}]);
    const listFlows = vi.fn(async () => [report()]);
    const f = setup({toolPackages: {list: listPackages, ensure: async () => {registered = true; return {tools: report().tools};}},
        flowInstallations: {list: listFlows, check: async () => report(), ensure: async () => {registered = true; return report();}}});
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-flow-ensure]')).not.toBeNull());
    f.dialog.querySelector<HTMLButtonElement>(target === 'package' ? '[data-package-ensure]' : '[data-flow-ensure]')!.click();
    await vi.waitFor(() => {
        expect(f.dialog.querySelector('[data-package-status]')!.textContent).toBe('已注册');
        expect(f.dialog.querySelector('[data-flow-id]')!.textContent).toContain('依赖已就绪');
    });
    expect(listPackages).toHaveBeenCalledTimes(2); expect(listFlows).toHaveBeenCalledTimes(2);
    expect(f.dialog.querySelector('[data-package-ensure]')).toBeNull(); expect(f.dialog.querySelector('[data-flow-ensure]')).toBeNull();
});
