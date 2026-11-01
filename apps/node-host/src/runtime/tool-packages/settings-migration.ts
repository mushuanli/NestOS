import type {InstalledToolPackage} from './install';
import type {ToolPreferences} from './preferences';
import {validateToolDefaults, type ToolboxDeclaration} from './toolbox';
import {packageError} from './manifest';

/** Each user migrates only their own explicitly saved, schema-compatible ordinary settings. */
export async function migratePackageSettings(installed: InstalledToolPackage, declaration: ToolboxDeclaration, preferences: ToolPreferences): Promise<void> {
    const {id, version, previousVersion} = installed.registration, key = `${id}@${version}`;
    if (!previousVersion || preferences.has(key) && !preferences.migratedFrom(key, previousVersion) || !preferences.has(`${id}@${previousVersion}`)) return;
    const settings = preferences.get(`${id}@${previousVersion}`);
    for (const [toolId, values] of Object.entries(settings.defaults)) {
        const tool = installed.tools.find(candidate => candidate.name === toolId), fields = declaration.tools[toolId]?.parameters;
        if (!tool || !fields) throw packageError('TOOL_PACKAGE_DEFAULT_INVALID', 'Saved defaults need review for this package version');
        validateToolDefaults(tool, fields.map(field => field.name), values);
    }
    await preferences.saveMigrated(key, previousVersion, {...settings, ...(settings.disabledTools ? {disabledTools: settings.disabledTools.filter(id => installed.tools.some(tool => tool.name === id))} : {})});
}
