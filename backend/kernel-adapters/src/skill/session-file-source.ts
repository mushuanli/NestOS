import type { SkillDefinition, SkillFrontmatter, SkillScopeLevel } from '@itookit/tools/contracts';
import type { ToolVFSContext } from '@itookit/tools/contracts';
import { extractCompactInstructions } from './compact-extractor';
import type { SkillScopeSnapshot, SkillSource } from '../ports/capabilities';

/** Platform-neutral Skill discovery backed only by an authorized Session file view. */
export class SessionFileSkillSource implements SkillSource {
    constructor(
        private readonly fs: Pick<ToolVFSContext, 'readFile' | 'listFiles'>,
        private readonly projectRoot: string,
        private readonly parseFrontmatter: (text: string) => unknown,
    ) {}

    async loadScope(cwd: string): Promise<SkillScopeSnapshot> {
        const roots = scopeRoots(this.projectRoot, cwd);
        if (!roots.length) return { cwd, skills: [], agentInstructions: '' };
        const skills = (await Promise.all(roots.map(root => this.loadDirectory(
            join(root, '_agent/skills'),
            scopeLevel(root, roots),
            root,
        )))).flat();
        return {
            cwd,
            skills,
            // Project rules are anchored to the project root only. A nested `_agent/AGENT.md`
            // (parent-fs/local-fs) is deliberately not merged or substituted: changing cwd must
            // not silently swap the project instructions. Skills still cascade per level.
            agentInstructions: await this.readText(join(this.projectRoot, '_agent/AGENT.md')) ?? '',
        };
    }

    async loadDirectory(
        dirPath: string,
        scope: SkillScopeLevel,
        scopeRoot: string,
    ): Promise<SkillDefinition[]> {
        let paths: string[];
        try { paths = await this.fs.listFiles(dirPath); }
        catch (error) { if (missing(error)) return []; throw error; }
        const prefix = `${dirPath.replace(/\/$/, '')}/`;
        const directories = paths.flatMap(path => {
            const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
            const parts = relative.split('/');
            return parts.length === 2 && parts[0] && parts[0] !== '..' && parts[0] !== '.' && parts[1] === 'SKILL.md'
                ? [join(dirPath, parts[0])] : [];
        });
        const loaded = await Promise.all([...new Set(directories)].map(path => this.loadSkill(path, scope, scopeRoot)));
        return loaded.filter((skill): skill is SkillDefinition => Boolean(skill));
    }

    private async loadSkill(
        dirPath: string,
        scopeLevel: SkillScopeLevel,
        scopeRoot: string,
    ): Promise<SkillDefinition | null> {
        const raw = await this.readText(join(dirPath, 'SKILL.md'));
        if (!raw) return null;
        const parsed = parseSkillMarkdown(raw, this.parseFrontmatter);
        if (!parsed) return null;
        return toSkillDefinition(parsed.frontmatter, parsed.body, dirPath, scopeLevel, scopeRoot, this.projectRoot);
    }

    private async readText(path: string): Promise<string | null> {
        try { return await this.fs.readFile(path); }
        catch (error) { if (missing(error)) return null; throw error; }
    }
}

interface ParsedSkill {
    frontmatter: SkillFrontmatter;
    body: string;
}

function parseSkillMarkdown(raw: string, parse: (text: string) => unknown): ParsedSkill | null {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return null;
    const frontmatter = parse(match[1]) as SkillFrontmatter;
    if (!frontmatter?.name) return null;
    return { frontmatter, body: raw.slice(match[0].length).trim() };
}

function toSkillDefinition(
    frontmatter: SkillFrontmatter,
    markdown: string,
    dirPath: string,
    scopeLevel: SkillScopeLevel,
    scopeRoot: string,
    projectRoot: string,
): SkillDefinition {
    const { body, compact } = extractCompactInstructions(markdown);
    const reference = !frontmatter['trigger-strategy']
        || frontmatter['trigger-strategy'] === 'reference';
    return {
        id: skillId(frontmatter.name),
        name: frontmatter.name,
        description: frontmatter.description ?? '',
        type: 'prompt', enabled: true, instructions: body, tools: [], triggerPatterns: [],
        autoLoad: reference && (frontmatter['auto-load'] ?? true),
        priority: frontmatter.priority ?? 50,
        versionPolicy: parseVersionPolicy(frontmatter['version-policy']),
        triggerStrategy: frontmatter['trigger-strategy'] ?? 'reference',
        source: 'filesystem', scopeLevel, scopeRoot,
        disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
        globs: frontmatter.globs ?? [], compact, referencePaths: frontmatter.references ?? [],
        templatePath: frontmatter.template, fsRoot: dirPath,
        correctionLog: typeof frontmatter['correction-log'] === 'string' && frontmatter['correction-log'].trim()
            ? { path: frontmatter['correction-log'], root: projectRoot, enabled: true } : undefined,
        supportsSubagent: Boolean(frontmatter.subagent), subagentRole: frontmatter.subagent?.role,
        subagentModel: typeof frontmatter.subagent?.model === 'string' ? frontmatter.subagent.model.trim() || undefined : undefined,
        taskProgram: validTaskProgram(frontmatter['task-program']),
    };
}

function parseVersionPolicy(value: unknown): SkillDefinition['versionPolicy'] {
    if (value === undefined || value === 'keep-old' || value === 'require-reload') return value;
    throw new Error('Invalid Skill version-policy');
}

function validTaskProgram(
    value: SkillFrontmatter['task-program'],
): SkillDefinition['taskProgram'] {
    if (!value || typeof value.kind !== 'string' || typeof value.version !== 'string') return undefined;
    if (!value.kind.trim() || !value.version.trim()) return undefined;
    return { kind: value.kind, version: value.version };
}

function scopeRoots(projectRoot: string, cwd: string): string[] {
    if (cwd === projectRoot) return [projectRoot];
    const prefix = projectRoot === '/' ? '/' : `${projectRoot}/`;
    if (!cwd.startsWith(prefix)) return [];
    const suffix = cwd.slice(prefix.length).split('/').filter(Boolean);
    return suffix.reduce<string[]>((roots, part) => [...roots, join(roots.at(-1)!, part)], [projectRoot]);
}

function scopeLevel(root: string, roots: string[]): SkillScopeLevel {
    if (root === roots[0]) return 'global-fs';
    if (root === roots.at(-1)) return 'local-fs';
    return 'parent-fs';
}

function join(...parts: string[]): string {
    const absolute = parts[0]?.startsWith('/') ?? false;
    const value = parts.flatMap(part => part.split('/')).filter(Boolean).join('/');
    return absolute ? `/${value}` : value;
}

function skillId(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function missing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
