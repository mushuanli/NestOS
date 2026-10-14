export interface TwinUserIdentity { userName?: string; userAliases?: string[]; }
export function userIdentity(value: TwinUserIdentity): TwinUserIdentity {
    if (value.userName !== undefined && (typeof value.userName !== 'string' || value.userName.length > 200)) invalid();
    if (value.userAliases !== undefined && (!Array.isArray(value.userAliases) || value.userAliases.length > 20
        || value.userAliases.some(name => typeof name !== 'string' || name.length > 200))) invalid();
    return { userName: value.userName?.trim() ?? '', userAliases: [...new Set((value.userAliases ?? []).map(name => name.trim()).filter(Boolean))] };
}
export const identityKey = (identity: TwinUserIdentity) => JSON.stringify(userIdentity(identity));
function invalid(): never { throw new Error('TWIN_INVALID_IDENTITY'); }
