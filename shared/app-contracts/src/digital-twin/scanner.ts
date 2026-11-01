import type {TargetRef, JsonValue} from '@itookit/llm-flow/contracts';

/** Published target plus ordinary arguments; input text uses the target's declared composer binding. */
export interface TwinScannerExecutor {target: TargetRef; values?: Record<string, JsonValue>; outputPath?: string[]}
export function scannerExecutor(value: TwinScannerExecutor | undefined): TwinScannerExecutor | undefined {
    if (value === undefined) return;
    const target = value?.target;
    if (!target || !['agent', 'flow'].includes(target.kind) || typeof target.id !== 'string' || !target.id.trim()
        || target.id.length > 256 || typeof target.version !== 'string' || !target.version || target.version.length > 128 || typeof target.digest !== 'string' || !target.digest || target.digest.length > 256)
        throw new Error('TWIN_SCANNER_TARGET_INVALID');
    if (value.values !== undefined && (!value.values || typeof value.values !== 'object' || Array.isArray(value.values))) throw new Error('TWIN_SCANNER_ARGUMENTS_INVALID');
    if (value.outputPath !== undefined && (!Array.isArray(value.outputPath) || value.outputPath.length > 20
        || value.outputPath.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key)))) throw new Error('TWIN_SCANNER_OUTPUT_INVALID');
    return structuredClone(value);
}

export type TwinScannerInput = {kind: 'text'; text: string} | {kind: 'file'; path: string};

export interface TwinWorkspaceView {id: string; name: string; kind: 'personal' | 'organization'; readOnly: boolean}

export interface TwinToolTarget {kind: 'tool'; id: string; version: string; digest: string}
export const TWIN_COLLECTION_WORKSPACES = ['emails', 'calendar', 'notes', 'home'] as const;
export type TwinCollectionWorkspace = typeof TWIN_COLLECTION_WORKSPACES[number];
export type TwinCollectionExecutor = (TwinScannerExecutor | {target: TwinToolTarget; values?: Record<string, JsonValue>}) & {
    destination?: TwinCollectionWorkspace; projectId?: string; directory?: string;
};
/** Tool-owned cursors stay private; the platform only observes batch completion and work counts. */
export interface TwinCollectionProgress {version: 1; complete: boolean; processed: number; batchCount?: number}
export interface TwinScannerTool {
    hidden?: boolean;
    presentation?: Pick<import('../ports/flow-installation').ToolPackageConfiguration['tools'][number], 'parameters' | 'advanced' | 'optionLabels'>;
    defaults?: Record<string, JsonValue>;
    target: TwinToolTarget; name: string; description: string; source: 'builtin' | 'plugin' | 'mcp';
    parameters: JsonValue;
}
export function collectionExecutor(value: TwinCollectionExecutor | undefined): TwinCollectionExecutor | undefined {
    if (value === undefined) return;
    if (value.projectId !== undefined && (value.target?.kind !== 'tool' || value.destination !== undefined
        || typeof value.projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.projectId)))
        throw new Error('TWIN_COLLECTION_DESTINATION_INVALID');
    if (value.directory !== undefined && (value.target?.kind !== 'tool' || !value.destination && !value.projectId
        || typeof value.directory !== 'string' || value.directory.length > 512 || !value.directory
        || value.directory.split('/').some(part => !part || part === '..' || part.startsWith('.') || /[\\\x00-\x1f:]/.test(part))))
        throw new Error('TWIN_COLLECTION_DIRECTORY_INVALID');
    if (value.destination !== undefined && (value.target?.kind !== 'tool' || !TWIN_COLLECTION_WORKSPACES.includes(value.destination)))
        throw new Error('TWIN_COLLECTION_DESTINATION_INVALID');
    if (value.target?.kind !== 'tool') {
        if (value.target?.kind !== 'flow') throw new Error('TWIN_COLLECTION_TARGET_INVALID');
        return scannerExecutor(value as TwinScannerExecutor);
    }
    scannerExecutor({...value, target: {...value.target, kind: 'flow'}});
    return structuredClone(value);
}
