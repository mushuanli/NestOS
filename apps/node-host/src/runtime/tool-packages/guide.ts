import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ToolPackageGuide, ToolPackageInfo} from '@itookit/app-contracts/services';
import {packageError, type ToolPackageSource} from './manifest';
import {readYamlSidecar, writeYamlSidecar} from './yaml-sidecar';
const log = createModuleLogger('tool-package-guide');
type GuideState = Pick<ToolPackageInfo, 'guide' | 'guideError'>;

/** A conventional sidecar is documentation, independent of the immutable executable package. */
export async function packageGuide(source: ToolPackageSource, fallback?: ToolPackageSource): Promise<GuideState> {
    const started = Date.now();
    try {
        const guide = await readPackageGuide(source.root) ?? (fallback ? await readPackageGuide(fallback.root) : undefined);
        return guide ? {guide} : {};
    } catch (error) {
        const code = (error as {code?: string}).code;
        const guideError = code?.startsWith('TOOL_PACKAGE_GUIDE_') ? code : 'TOOL_PACKAGE_GUIDE_READ_FAILED';
        log.warn('tool.package.guide', {operationId: randomUUID(), stage: 'read', result: 'failure', code: guideError,
            packageId: source.manifest.id, version: source.manifest.version, durationMs: Date.now() - started});
        return {guideError};
    }
}
export async function copyPackageGuide(source: ToolPackageSource, destination: string): Promise<void> {
    const {guide} = await packageGuide(source);
    if (guide) await writeYamlSidecar(destination, 'guide', guide);
}
export async function readPackageGuide(root: string): Promise<ToolPackageGuide | undefined> {
    const value = await readYamlSidecar(root, 'guide');
    return value === undefined ? undefined : validateGuide(value);
}

function validateGuide(value: unknown): ToolPackageGuide {
    const data = object(value);
    if (data.version !== 1 || !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 30) invalid();
    const connectionTypes = data.connectionTypes;
    if (connectionTypes !== undefined && (!Array.isArray(connectionTypes) || connectionTypes.length > 30 ||
        connectionTypes.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)))) invalid();
    return {version: 1, title: field(data.title, 160), ...(data.description === undefined ? {} : {description: field(data.description, 4000)}),
        ...(connectionTypes === undefined ? {} : {connectionTypes: [...new Set(connectionTypes as string[])]}),
        steps: (data.steps as unknown[]).map(value => {
            const step = object(value);
            return {title: field(step.title, 160), description: field(step.description, 8000),
                ...(step.command === undefined ? {} : {command: field(step.command, 8000)}),
                ...(step.links === undefined ? {} : {links: links(step.links)})};
        })};
}
function links(value: unknown): Array<{label: string; url: string}> {
    if (!Array.isArray(value) || value.length > 8) invalid();
    return (value as unknown[]).map(item => {
        const link = object(item), href = field(link.url, 2000); let url;
        try {url = new URL(href);} catch {invalid();}
        if (url!.protocol !== 'https:' || url!.username || url!.password) invalid();
        return {label: field(link.label, 160), url: url!.href};
    });
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
}
function field(value: unknown, limit: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) invalid();
    return value as string;
}
function invalid(): never {throw packageError('TOOL_PACKAGE_GUIDE_INVALID', 'Guide fields do not match the documentation format');}
