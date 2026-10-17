/** No shell expansion: quotes only group a path containing whitespace. */
export function parseDirectoryCommand(raw: string, permission = true): { directory?: string; access: 'ro' | 'rw' } {
    const tokens: string[] = [];
    let token = '', quote = '', started = false;
    for (const ch of raw.trim()) {
        if (quote) { if (ch === quote) quote = ''; else token += ch; }
        else if (ch === '"' || ch === "'") { quote = ch; started = true; }
        else if (/\s/.test(ch)) { if (started) { tokens.push(token); token = ''; started = false; } }
        else { token += ch; started = true; }
    }
    if (quote) throw new Error('目录引号未闭合');
    if (started) tokens.push(token);
    if (tokens.length > (permission ? 2 : 1) || (tokens.length === 2 && !['r', 'w'].includes(tokens[1]))) throw new Error(permission ? '用法：/add-dir <dir> [r|w]' : '用法：/set-home <dir>');
    if (tokens[0] === '') throw new Error('目录不能为空');
    return { directory: tokens[0], access: tokens[1] === 'r' ? 'ro' : 'rw' };
}
