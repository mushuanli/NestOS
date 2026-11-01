import {escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {ToolPackageInfo} from '@itookit/app-contracts/services';
const label = (key: string) => t(`toolbox.packages.${key}` as LocaleKey);

export function versionAction(item: ToolPackageInfo, versions: ToolPackageInfo[], busy: boolean): string {
    if (item.pendingVersion) return `<p role="status">${escapeHTML(label('versionPending').replace('{version}', item.pendingVersion))}</p>`;
    const target = versions.filter(version => version.canSwitch).sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true}))[0];
    return `${item.activationId ? `<p role="status">${escapeHTML(label('upgraded').replace('{version}', item.version))}</p>` : ''}${target ? switchButton(item, target, busy) : ''}${runningVersions(item)}`;
}

export function runningVersions(item: ToolPackageInfo): string {
    return (item.runningVersions ?? []).map(row => `<p role="status">${escapeHTML(label('drainingVersion').replace('{version}', row.version).replace('{count}', String(row.count)))}</p>`).join('');
}

export function packageVersions(item: ToolPackageInfo, versions: ToolPackageInfo[], busy: boolean): string {
    const needsAdmin = item.status === 'registered' && !item.pendingVersion && versions.some(version => version.status === 'available') && !versions.some(version => version.canSwitch);
    return `${needsAdmin ? `<p>${escapeHTML(label('versionAdminHelp'))}</p>` : ''}<ul>${versions.map(version => {
        const status = version.version === item.pendingVersion ? label('versionPrepared') : version.status === 'registered' ? label('activeVersion')
            : version.status === 'available' ? label('availableVersion') : label(version.status);
        return `<li>${escapeHTML(version.version)} · ${escapeHTML(status)}${version.canSwitch && !item.pendingVersion ? switchButton(item, version, busy) : ''}</li>`;
    }).join('')}</ul>`;
}

function switchButton(active: ToolPackageInfo, target: ToolPackageInfo, busy: boolean): string {
    return `<button type="button" data-package-switch="${escapeHTML(active.id)}" data-package-version="${escapeHTML(target.version)}" data-expected-version="${escapeHTML(active.version)}"${busy ? ' disabled' : ''}>${escapeHTML(label('switchVersion').replace('{version}', target.version))}</button>`;
}
