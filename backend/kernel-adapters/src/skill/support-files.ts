import type { SkillDefinition } from '@itookit/tools/contracts';

/** Read explicitly declared supporting material through the Session's authorized file port. */
export async function skillSupportPrompt(skill: SkillDefinition, read?: (path: string) => Promise<string>): Promise<string> {
    const files = [
        ...(skill.referencePaths ?? []).map(path => ({ label: 'Reference', root: skill.fsRoot, path })),
        ...(skill.templatePath ? [{ label: 'Output template', root: skill.fsRoot, path: skill.templatePath }] : []),
        ...(skill.correctionLog?.enabled ? [{ label: 'Correction log', root: skill.correctionLog.root ?? skill.scopeRoot, path: skill.correctionLog.path }] : []),
    ];
    if (!files.length) return '';
    if (!read) throw new Error('Skill supporting files require a Session file capability');
    if (files.length > 20) throw new Error('Too many Skill supporting files');
    // Validate every declaration before performing any IO.
    const paths = files.map(file => supportPath(file.root, file.path));
    const parts: string[] = [];
    let total = 0;
    for (const [index, path] of paths.entries()) {
        const content = await read(path);
        const bytes = new TextEncoder().encode(content).byteLength;
        total += bytes;
        if (bytes > 64 * 1024 || total > 256 * 1024) throw new Error('Skill supporting content exceeds size limit');
        parts.push(`${files[index].label} (${files[index].path}):\n${content}`);
    }
    return parts.join('\n\n');
}

function supportPath(root: string | undefined, relative: string): string {
    const invalid = (value: string) => /[\\\u0000-\u001f]/.test(value) || value.split('/').some(part => part === '..' || part === '.');
    if (!root || !root.startsWith('/') || invalid(root)) throw new Error('Skill support root must be an authorized virtual absolute path');
    if (typeof relative !== 'string' || !relative.trim() || relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(relative) || invalid(relative)) {
        throw new Error('Skill support file must be a relative path without traversal');
    }
    return `${root.replace(/\/+$/, '')}/${relative}`;
}
