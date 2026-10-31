import '@itookit/llm-ui/forms.css';
import {escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {ToolPackageInfo, ToolPackageSettings} from '@itookit/app-contracts/services';
import {renderParameterFields, readParameterFields} from '@itookit/llm-ui/forms';
const label = (key: string) => escapeHTML(t(`toolbox.packages.${key}` as LocaleKey));

export function packageConfiguration(item: ToolPackageInfo, busy: boolean): string {
    const config = item.configuration;
    if (!config || item.status !== 'registered') return '';
    return `<form class="tool-packages-dialog__configuration" data-form="toolPackage" data-package-id="${escapeHTML(item.id)}" data-package-version="${escapeHTML(item.version)}">
        <label><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>${label('enabledForMe')}</label>
        <p>${label('personalHelp')}</p><details data-package-preferences="${escapeHTML(item.id + '@' + item.version)}"><summary>${label('personalDefaults')}</summary>
        ${config.tools.filter(tool => !tool.hidden).map(tool => `<details data-package-preferences="${escapeHTML(item.id + '@' + item.version + '/' + tool.id)}"><summary>${escapeHTML(tool.label ?? tool.id)}</summary><label><input type="checkbox" data-tool-enabled="${escapeHTML(tool.id)}"${config.disabledTools?.includes(tool.id) ? '' : ' checked'}>${label('enabledForMe')}</label><fieldset aria-label="${escapeHTML(tool.id)}" data-package-tool="${escapeHTML(tool.id)}" ${busy ? 'disabled' : ''}>
            ${toolFields(tool, config)}</fieldset></details>`).join('')}</details><button type="submit" ${busy ? 'disabled' : ''}>${label('savePersonal')}</button></form>`;
}
export function readPackageSettings(form: HTMLFormElement, item: ToolPackageInfo): ToolPackageSettings {
    const defaults = Object.fromEntries(item.configuration!.tools.filter(tool => tool.parameters.length).map(tool => {
        const fields = [...form.querySelectorAll<HTMLElement>('[data-package-tool]')].find(node => node.dataset.packageTool === tool.id)!;
        if (!fields) return [tool.id, item.configuration!.defaults[tool.id] ?? {}];
        return [tool.id, readParameterFields(fields, tool.parameters, {mode: 'defaults'})];
    }));
    const disabledTools = [...(item.configuration!.disabledTools ?? []).filter(id => ![...form.querySelectorAll<HTMLInputElement>('[data-tool-enabled]')].some(input => input.dataset.toolEnabled === id)), ...[...form.querySelectorAll<HTMLInputElement>('[data-tool-enabled]')].filter(input => !input.checked).map(input => input.dataset.toolEnabled!)];
    return {...(disabledTools.length || item.configuration!.disabledTools ? {disabledTools} : {}), enabled: form.querySelector<HTMLInputElement>('[name=enabled]')!.checked, defaults};
}

function toolFields(tool: NonNullable<ToolPackageInfo['configuration']>['tools'][number], config: NonNullable<ToolPackageInfo['configuration']>): string {
    const render = (fields: typeof tool.parameters) => renderParameterFields(fields, {mode: 'defaults', optionLabel: (value, field) => tool.optionLabels?.[field.name]?.[String(value)] ?? String(value), values: {...Object.fromEntries(tool.parameters.filter(field => field.widget === 'select' && field.options?.length === 1 && field.default !== undefined).map(field => [field.name, field.default])), ...config.defaults[tool.id]}, namePrefix: `${tool.id}.`, labels: {
                defaultValue: value => t('toolbox.packages.defaultValue').replace('{value}', value), inherit: t('toolbox.packages.inheritDefault'), on: t('toolbox.packages.valueOn'), off: t('toolbox.packages.valueOff'),
            }});
    const basic = tool.parameters.filter(field => !tool.advanced?.includes(field.name)), advanced = tool.parameters.filter(field => tool.advanced?.includes(field.name));
    return render(basic) + (advanced.length ? `<details><summary>${escapeHTML(t('toolbox.connections.advancedConnection'))}</summary>${render(advanced)}</details>` : '');
}
