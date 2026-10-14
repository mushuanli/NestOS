// @file: kernel-adapters/src/skill/session-file-source.test.ts
// P0-00 file source contract: `auto-load` can express a loadable Skill that new runs must
// not inject automatically, and project rules stay anchored to the project root while
// Skills cascade through the projectRoot → cwd scope chain.
import { expect, it } from 'vitest';
import { SessionFileSkillSource } from './session-file-source';

/** Minimal YAML subset used by these fixtures; real hosts pass the `yaml` parser. */
function parseFrontmatter(text: string): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    for (const line of text.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) continue;
        const [, key, raw] = match;
        parsed[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
    }
    return parsed;
}

function source(files: Record<string, string>, projectRoot = '/workspace'): SessionFileSkillSource {
    const paths = Object.keys(files);
    return new SessionFileSkillSource({
        listFiles: async dir => {
            const prefix = `${dir.replace(/\/+$/, '')}/`;
            return paths.filter(path => path.startsWith(prefix));
        },
        readFile: async path => {
            const content = files[path];
            if (content === undefined) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
            return content;
        },
    }, projectRoot, parseFrontmatter);
}

function skill(name: string, extra: string): string {
    return `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n${name} body\n`;
}

it('derives autoLoad from trigger-strategy unless auto-load explicitly overrides it', async () => {
    const loaded = await source({
        '/workspace/_agent/skills/auto/SKILL.md': skill('Auto', ''),
        '/workspace/_agent/skills/manual/SKILL.md': skill('Manual', 'trigger-strategy: reference\nauto-load: false\n'),
        '/workspace/_agent/skills/action/SKILL.md': skill('Action', 'trigger-strategy: action\nauto-load: true\n'),
    }).loadScope('/workspace');
    const byId = new Map(loaded.skills.map(item => [item.id, item]));
    // Default reference still auto-loads; the explicit override keeps it loadable but inert.
    expect(byId.get('auto')).toMatchObject({ autoLoad: true, triggerStrategy: 'reference' });
    expect(byId.get('manual')).toMatchObject({ autoLoad: false, triggerStrategy: 'reference' });
    // An action Skill never auto-loads, even if it carries a contradictory override.
    expect(byId.get('action')).toMatchObject({ autoLoad: false, triggerStrategy: 'action' });
});

it('cascades Skills through the scope chain but anchors project rules to the project root', async () => {
    const loaded = await source({
        '/workspace/_agent/AGENT.md': 'root rules',
        '/workspace/packages/app/_agent/AGENT.md': 'nested rules',
        '/workspace/_agent/skills/shared/SKILL.md': skill('Shared', ''),
        '/workspace/packages/app/_agent/skills/shared/SKILL.md': skill('Shared', 'priority: 10\n'),
        '/workspace/packages/app/_agent/skills/local/SKILL.md': skill('Local', ''),
    }).loadScope('/workspace/packages/app');

    // A nested `_agent/AGENT.md` must not silently replace the project instructions.
    expect(loaded.agentInstructions).toBe('root rules');
    expect(loaded.skills.map(item => `${item.id}:${item.scopeLevel}`).sort())
        .toEqual(['local:local-fs', 'shared:global-fs', 'shared:local-fs']);
    // The deeper definition wins for a duplicated id, so the caller can prefer local-fs.
    const nested = loaded.skills.find(item => item.id === 'shared' && item.scopeLevel === 'local-fs');
    expect(nested?.instructions).toBe('Shared body');
});

it('returns no definitions when the working directory leaves the project root', async () => {
    const loaded = await source({ '/workspace/_agent/AGENT.md': 'root rules' }).loadScope('/elsewhere');
    expect(loaded).toEqual({ cwd: '/elsewhere', skills: [], agentInstructions: '' });
});
