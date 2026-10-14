// @file: device-llm/device/skill-manager.ts
//
// SkillManager — SkillDefinition CRUD, HTTP/Shell/MCP invocation.

import type { LLMSkill } from '@itookit/kernel-adapters/contracts';
import type { SkillToolBinding } from '@itookit/tools/contracts';
import type { IVFSManager, IFileSystem } from '@itookit/vfs-core';
import yaml from 'js-yaml';
import { VFSHelpers } from './vfs-helpers';
import type { MCPManager } from './mcp-manager';
import type { IShellRunner } from './llm-device-driver';

const SKILLS_DIR = '/llm/.skills';
const SKILL_TYPES = new Set(['builtin', 'http', 'shell', 'prompt', 'mcp', 'custom']);
const TOOL_EXECUTION_TYPES = new Set(['builtin', 'http', 'shell', 'handler', 'mcp']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a tool binding before it can be registered by the Skill loader. */
export function isSkillToolBinding(value: unknown): value is SkillToolBinding {
    if (!isRecord(value)) return false;
    if (typeof value.toolId !== 'string' || value.toolId.trim().length === 0) return false;
    if (!isRecord(value.definition)) return false;

    const functionDef = value.definition.function;
    if (functionDef !== undefined && !isRecord(functionDef)) return false;
    const name = typeof value.definition.name === 'string' ? value.definition.name.trim() : '';
    const functionName = functionDef && typeof functionDef.name === 'string' ? functionDef.name.trim() : '';
    if (!name && !functionName) return false;

    if (value.executionType !== undefined
        && (typeof value.executionType !== 'string' || !TOOL_EXECUTION_TYPES.has(value.executionType))) {
        return false;
    }
    return true;
}

/** Validate a parsed Skill before it enters the catalog. */
export function isSkillDefinition(value: unknown): value is LLMSkill {
    if (!isRecord(value)) return false;
    return typeof value.id === 'string' && value.id.trim().length > 0
        && typeof value.name === 'string'
        && typeof value.description === 'string'
        && typeof value.type === 'string' && SKILL_TYPES.has(value.type)
        && typeof value.enabled === 'boolean'
        && typeof value.instructions === 'string'
        && Array.isArray(value.tools)
        && value.tools.every(isSkillToolBinding)
        && Array.isArray(value.triggerPatterns)
        && typeof value.autoLoad === 'boolean'
        && typeof value.priority === 'number' && Number.isFinite(value.priority);
}

export class SkillManager {
    private _skills: LLMSkill[] = [];

    constructor(
        private readonly helpers: VFSHelpers,
        private readonly vfs: IVFSManager,
        private readonly mcpManager: MCPManager,
        private readonly shellRunner: IShellRunner | undefined,
        private readonly onChanged: () => void,
    ) {}

    // ─── Read accessors ────────────────────────────────────────────────────

    getSkills(): LLMSkill[] {
        return [...this._skills];
    }

    getRawSkills(): LLMSkill[] {
        return this._skills;
    }

    findSkill(id: string): LLMSkill | undefined {
        return this._skills.find(s => s.id === id);
    }

    // ─── Mutations ─────────────────────────────────────────────────────────

    async saveSkill(skill: LLMSkill, systemFS?: IFileSystem): Promise<void> {
        const candidate: unknown = skill;
        if (!isSkillDefinition(candidate)) {
            const id = isRecord(candidate) && typeof candidate.id === 'string' ? candidate.id : '<unknown>';
            throw new Error(`Invalid skill definition: ${id}`);
        }

        const next = { ...candidate, modifiedAt: Date.now() };
        await this.writeSkillToDisk(next, systemFS);
        const idx = this._skills.findIndex(s => s.id === next.id);
        if (idx >= 0) { this._skills[idx] = next; } else { this._skills.push(next); }
        await this.vfs.createDeviceNode('llm', `/dev/llm/skills/${next.id}`, {
            resourceType: 'skill',
            resourceId: next.id,
        });
        this.onChanged();
    }

    async deleteSkill(id: string, systemFS?: IFileSystem): Promise<void> {
        await this.deleteSkillFromDisk(id, systemFS);
        this._skills = this._skills.filter(s => s.id !== id);
        await this.vfs.removeDeviceNode(`/dev/llm/skills/${id}`);
        this.onChanged();
    }

    // ─── Init helpers ──────────────────────────────────────────────────────

    setSkills(skills: LLMSkill[]): void {
        this._skills = skills.filter(isSkillDefinition);
    }

    // ─── VFS reload ────────────────────────────────────────────────────────

    async loadAllSkills(): Promise<LLMSkill[]> {
        return this.helpers.loadYamlFilesFromDir<LLMSkill>(SKILLS_DIR, undefined, isSkillDefinition);
    }

    async reload(): Promise<void> {
        this._skills = await this.loadAllSkills();
    }

    // ─── Invocation ────────────────────────────────────────────────────────

    async invokeSkill(skill: LLMSkill, args: Record<string, unknown>): Promise<unknown> {
        switch (skill.type) {
            case 'http':
                return this.invokeHttpSkill(skill, args);
            case 'shell':
                return this.invokeShellSkill(skill, args);
            case 'mcp':
                return this.invokeMcpSkill(skill, args);
            case 'prompt':
                return `[Skill '${skill.name}' provides context instructions — it is not a callable tool.]`;
            default:
                throw new Error(`Skill '${skill.id}': type '${skill.type}' is not invocable`);
        }
    }

    // ─── Private helpers ───────────────────────────────────────────────────

    private async writeSkillToDisk(skill: LLMSkill, systemFS?: IFileSystem): Promise<void> {
        await this.helpers.engineUpsert(
            `${SKILLS_DIR}/${skill.id}.yaml`,
            yaml.dump(skill, { lineWidth: -1, noRefs: true }),
            systemFS,
        );
    }

    private async deleteSkillFromDisk(id: string, systemFS?: IFileSystem): Promise<void> {
        const fs = systemFS ?? this.helpers.getFileSystem();
        const nodeId = await fs.driver.resolvePath(`${SKILLS_DIR}/${id}.yaml`);
        if (nodeId) await fs.driver.delete([nodeId]);
    }

    private async invokeHttpSkill(skill: LLMSkill, args: Record<string, unknown>): Promise<unknown> {
        if (!skill.endpoint) throw new Error(`Skill '${skill.id}' has no endpoint configured`);
        const response = await fetch(skill.endpoint, {
            method: skill.method ?? 'POST',
            headers: { 'Content-Type': 'application/json', ...skill.headers },
            body: JSON.stringify(args),
        });
        if (!response.ok) throw new Error(`Skill '${skill.name}' invocation failed: HTTP ${response.status}`);
        const ct = response.headers.get('content-type') ?? '';
        return ct.includes('application/json') ? response.json() : response.text();
    }

    private async invokeShellSkill(skill: LLMSkill, args: Record<string, unknown>): Promise<string> {
        const shellTool = skill.tools?.find(t => t.executionType === 'shell');
        const command = shellTool?.command;
        if (!command) throw new Error(`Skill '${skill.id}' has no command configured`);
        if (!this.shellRunner) {
            return (
                `Shell skills require a native execution environment.\n` +
                `Inject an IShellRunner when constructing LLMDeviceDriver, or use the kernel path.`
            );
        }
        return this.shellRunner.run(command, args);
    }

    private async invokeMcpSkill(skill: LLMSkill, args: Record<string, unknown>): Promise<unknown> {
        const { mcpServerId, mcpToolName } = skill;
        if (!mcpServerId || !mcpToolName) {
            throw new Error(`MCP skill '${skill.id}' requires mcpServerId and mcpToolName`);
        }
        const conn = await this.mcpManager.getOrConnectServer(mcpServerId, this.mcpManager.getServers());
        const result = await conn.callTool(mcpToolName, args);
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
}
