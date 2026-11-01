// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import type {ToolPackageInfo, ToolPackages} from '@itookit/app-contracts/services';
import type {TwinScannerTool} from '@itookit/app-contracts';
import {scannerPackages, upgradeScannerPackage} from '../src/digital-twin/package-upgrades';
const tool = {target: {id: 'fixture.collect'}} as TwinScannerTool;
const active: ToolPackageInfo = {id: 'fixture', name: 'Fixture', version: '1.0.0', status: 'registered', tools: [{id: 'fixture.collect', version: '1'}]};
const next: ToolPackageInfo = {...active, version: '1.1.0', status: 'available', canSwitch: true};
it('offers upgrades for the scanner tool owner without offering downgrades or unrelated packages', () => {
    const html = scannerPackages([active, next, {...next, version: '0.9.0'}, {...next, id: 'unrelated'}], [tool]);
    expect(html).toContain('升级到 1.1.0'); expect(html).not.toContain('升级到 0.9.0'); expect(html).not.toContain('unrelated');
    expect(scannerPackages([{...active, pendingVersion: '1.1.0'}, next], [tool])).toContain('核对');
    expect(scannerPackages([{...active, pendingVersion: '1.1.0'}, next], [tool])).not.toContain('data-action="upgradeScannerPackage"');
});
it('rechecks the registered version and permissions before staging an upgrade', async () => {
    const switchVersion = vi.fn(async () => {});
    const port = {list: async () => [active, next], switchVersion} as unknown as ToolPackages;
    await upgradeScannerPackage(port, active.id, next.version, active.version);
    expect(switchVersion).toHaveBeenCalledWith(active.id, next.version, active.version, expect.any(String));
    port.list = async () => [{...active, pendingVersion: next.version}, next];
    await expect(upgradeScannerPackage(port, active.id, next.version, active.version)).rejects.toThrow('TOOL_PACKAGE_VERSION_CONFLICT');
    expect(switchVersion).toHaveBeenCalledTimes(1);
});

it('shows an activated version immediately and explains draining calls without requesting a restart', () => {
    const html = scannerPackages([{...active, version: next.version, activationId: 'upgrade', runningVersions: [{version: active.version, count: 2}]}], [tool]);
    expect(html).toContain('立即生效'); expect(html).toContain('2 个执行'); expect(html).not.toContain('核对');
    expect(html).not.toContain('data-action="upgradeScannerPackage"');
});
