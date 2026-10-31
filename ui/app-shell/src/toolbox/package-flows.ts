import {escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {ToolPackageInfo} from '@itookit/app-contracts/services';
const label = (key: string) => t(`toolbox.packages.${key}` as LocaleKey);
export const packageFlowKey = (item: ToolPackageInfo): string => item.id + '@' + item.version;

/** Installation means library presence, independent of account and execution readiness. */
export function packageFlows(item: ToolPackageInfo, busy: boolean, installing = false, added?: number): string {
    if (!item.flowCount || item.status !== 'registered') return '';
    const total = item.flowResources?.length ?? item.flowCount, installed = item.flowResources?.filter(flow => flow.installed).length;
    const complete = installed !== undefined ? total > 0 && installed === total : added !== undefined;
    const title = installing ? label('flowsInstalling') : complete ? label('flowsInstalled') : label('installFlows');
    const notice = added !== undefined ? added ? label('flowsAdded').replace('{count}', String(added)) : label('flowsAlreadyInstalled')
        : installed ? label('flowsPresent').replace('{installed}', String(installed)).replace('{total}', String(total)) : '';
    return `<div data-package-flow-controls><button type="button" data-package-flows="${escapeHTML(item.id)}" data-package-version="${escapeHTML(item.version)}"
        title="${escapeHTML(label('flowsHelp'))}"${busy || complete ? ' disabled' : ''}${installing ? ' aria-busy="true"' : ''}>${escapeHTML(title)} (${total})</button>
        <p data-package-flow-status role="status" aria-live="polite">${escapeHTML(installing ? label('flowsInstalling') : notice)}</p>
        ${!complete ? `<small>${escapeHTML(label('flowsHelp'))}</small>` : ''}
        ${item.flowResources?.length ? `<small>${escapeHTML(item.flowResources.map(flow => flow.name).join(' · '))}</small>` : ''}
        ${item.flowResourceError ? `<p>${escapeHTML(label('flowsStatusUnavailable'))} (${escapeHTML(item.flowResourceError)})</p>` : ''}</div>`;
}
