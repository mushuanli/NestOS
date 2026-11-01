import {createModuleLogger, escapeAttr, escapeHTML, randomUUID, t} from '@itookit/common';
import type {ToolPackageInfo, ToolPackages} from '@itookit/app-contracts/services';
import type {TwinScannerTool} from '@itookit/app-contracts';
import {runningVersions} from '../toolbox/package-versions';
const log = createModuleLogger('scanner-packages');

export function scannerPackages(packages: ToolPackageInfo[], tools: TwinScannerTool[]): string {
    const ids = new Set(tools.map(tool => tool.target.id));
    const active = packages.filter(item => item.status === 'registered' && item.tools.some(tool => ids.has(tool.id)));
    if (!active.length) return '';
    return `<section class="twin__panel twin__package-upgrades"><h3>${escapeHTML(t('twin.scannerPackages'))}</h3>${active.map(item => packageRow(item, packages)).join('')}</section>`;
}

function packageRow(active: ToolPackageInfo, packages: ToolPackageInfo[]): string {
    const newer = packages.filter(item => item.id === active.id && item.status === 'available'
        && item.version.localeCompare(active.version, undefined, {numeric: true}) > 0)
        .sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true}));
    const target = newer.find(item => item.canSwitch);
    const action = active.pendingVersion ? `<span role="status">${escapeHTML(t('toolbox.packages.versionPending').replace('{version}', active.pendingVersion))}</span>`
        : target ? `<button type="button" data-action="upgradeScannerPackage" data-id="${escapeAttr(active.id)}" data-version="${escapeAttr(target.version)}" data-expected="${escapeAttr(active.version)}">${escapeHTML(t('twin.upgradePackage').replace('{version}', target.version))}</button>`
        : `<span>${escapeHTML(t(newer.length ? 'toolbox.packages.versionAdminHelp' : 'twin.packageCurrent'))}</span>`;
    return `<div class="twin__package-row"><span>${escapeHTML(active.name ?? active.id)} · ${escapeHTML(active.version)}</span>${action}
        ${active.activationId ? `<span role="status">${escapeHTML(t('toolbox.packages.upgraded').replace('{version}', active.version))}</span>` : ''}${runningVersions(active)}</div>`;
}

export async function upgradeScannerPackage(port: ToolPackages, id: string, version: string, expected: string): Promise<void> {
    const operationId = randomUUID(), started = Date.now();
    try {
        if (!port.switchVersion) throw new Error('TOOL_PACKAGE_SWITCH_UNAVAILABLE');
        const packages = await port.list();
        if (!packages.some(item => item.id === id && item.version === expected && item.status === 'registered' && !item.pendingVersion)
            || !packages.some(item => item.id === id && item.version === version && item.canSwitch)) throw new Error('TOOL_PACKAGE_VERSION_CONFLICT');
        await port.switchVersion(id, version, expected, operationId);
        log.info('scanner.package.upgrade', {operationId, stage: 'activate', result: 'success', packageId: id, version, durationMs: Date.now() - started});
    } catch (error) {
        const code = (error as {code?: string}).code ?? (error instanceof Error ? error.message : '');
        log.warn('scanner.package.upgrade', {operationId, stage: 'prepare', result: 'failure', code: /^TOOL_PACKAGE_[A-Z_]+$/.test(code) ? code : 'TOOL_PACKAGE_SWITCH_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
