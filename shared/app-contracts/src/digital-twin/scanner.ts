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
