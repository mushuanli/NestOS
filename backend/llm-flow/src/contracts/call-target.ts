/** Selection is caller intent; a reference identifies the definition actually admitted by the host. */
export interface TargetSelection {kind: 'agent' | 'flow'; id: string; version?: string}
export interface TargetRef extends TargetSelection {version: string; digest: string}

export function isTargetSelection(value: unknown): value is TargetSelection {
    if (!record(value) || value.kind !== 'agent' && value.kind !== 'flow' || !text(value.id)) return false;
    return Object.keys(value).every(key => ['kind', 'id', 'version'].includes(key))
        && (value.version === undefined || text(value.version));
}

export function isTargetRef(value: unknown): value is TargetRef {
    if (!record(value)) return false;
    const {digest, ...selection} = value;
    return isTargetSelection(selection) && text(selection.version) && text(digest);
}

export function assertTargetSelection(value: unknown): asserts value is TargetSelection {
    if (!isTargetSelection(value)) throw targetError('CALL_TARGET_INVALID', 'Invalid call target selection');
}

export function flowTargetRevision(target: TargetSelection): number | undefined {
    if (target.kind !== 'flow') throw targetError('CALL_TARGET_KIND_INVALID', 'A Flow target is required');
    if (target.version === undefined) return;
    const revision = Number(target.version);
    if (!Number.isSafeInteger(revision) || revision < 1 || String(revision) !== target.version)
        throw targetError('CALL_TARGET_VERSION_INVALID', 'Flow version must be a positive revision number');
    return revision;
}

export function assertSelectedTarget(selection: TargetSelection, actual: TargetRef): void {
    assertTargetSelection(selection);
    if (!isTargetRef(actual) || selection.kind !== actual.kind || selection.id !== actual.id
        || selection.version !== undefined && selection.version !== actual.version)
        throw targetError('CALL_TARGET_CHANGED', 'Call target changed before admission');
}

export function targetLabels(target?: TargetRef): Record<string, string> {
    return target ? {targetKind: target.kind, targetId: target.id, targetVersion: target.version, targetDigest: target.digest} : {};
}
export function sameTargetRef(left?: TargetRef, right?: TargetRef): boolean {
    return !left || !right ? left === right : left.kind === right.kind && left.id === right.id
        && left.version === right.version && left.digest === right.digest;
}
function text(value: unknown): value is string {return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;}
function record(value: unknown): value is Record<string, unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function targetError(code: string, message: string): Error {return Object.assign(new Error(message), {code});}
