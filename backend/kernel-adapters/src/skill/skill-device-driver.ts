// @file: kernel-adapters/src/skill/skill-device-driver.ts
// Skill 设备驱动：包装 ISkillService，实现 IDeviceDriver。

import type { ISkillService, SkillDefinition, SkillToolBinding, SkillLoadResult, SkillRouteLayer, SkillMatchContext, SkillScopeLevel, ParsedCompactInstructions, SkillVersionSnapshot, SkillVersionDrift } from '@itookit/tools/contracts';
import type { IToolService } from '@itookit/tools/contracts';
import type {
    IDeviceDriver,
    DeviceContext,
} from '@itookit/vfs-core';
import { aggregateCompactInstructions } from './compact-extractor';
import { matchGlob } from './glob-matcher';
import { skillSupportPrompt } from './support-files';
import type { SkillSource, SkillToolHandlerFactory } from '../ports/capabilities';
import { createSkillVersionSnapshot, snapshotLoadResult, validateSkillVersionSnapshot } from './version-snapshot';

export interface SkillDeviceDriverOptions {
    registry?: Map<string, SkillDefinition>;
    source?: SkillSource;
    toolHandlerFactory?: SkillToolHandlerFactory;
    readFile?: (path: string) => Promise<string>;
}

export class SkillDeviceDriver implements IDeviceDriver, ISkillService {
    readonly handlerId = 'skills';
    readonly description = 'Skill management device';
    readonly writable = false;
    readonly streamable = false;
    readonly sessionable = false;

    private readonly registry: Map<string, SkillDefinition>;
    private readonly activationRevisions = new Map<string, number>();
    private readonly fileSystemLoadIntent = new Set<string>();
    private loaded = new Set<string>();
    private readonly snapshots = new Map<string, SkillVersionSnapshot>();
    private readonly pins = new Map<string, SkillVersionSnapshot>();
    private readonly drifts = new Map<string, SkillVersionDrift>();
    private changeListeners: Array<() => void> = [];
    private toolService: IToolService | null = null;

    // ── 新增：作用域 & Glob 状态 ──
    /** skillId → 当前挂载该 skill 的文件路径集合（L4 glob 联动） */
    private globMounted = new Map<string, Set<string>>();
    private cwd: string = '';
    private readonly fileSystemSkills = new Map<string, SkillDefinition>();
    private scopeRevision = 0;
    private closed = false;
    private registeredTools = new Map<string, Set<string>>();
    /** _agent/AGENT.md 内容（项目级永久指令，始终注入系统 Prompt） */
    private agentMdContent: string = '';

    constructor(private readonly options: SkillDeviceDriverOptions = {}) {
        this.registry = options.registry ?? new Map<string, SkillDefinition>();
    }

    /** Inject ToolService so loadSkill can register HTTP-backed tools. */
    setToolService(toolService: IToolService): void {
        this.toolService = toolService;
    }

    async init(): Promise<void> {}
    async dispose(): Promise<void> {
        this.closed = true;
        this.fileSystemLoadIntent.clear();
        this.scopeRevision++;
        for (const id of [...this.loaded]) this.deactivateSkill(id);
        this.fileSystemSkills.clear();
        this.pins.clear();
        this.drifts.clear();
        this.agentMdContent = '';
        this.changeListeners = [];
    }

    // ── IDeviceDriver ──

    async read(_ctx: DeviceContext): Promise<string> {
        return this.listSkills().map((s) => `${s.id}: ${s.name}`).join('\n');
    }

    async write(_ctx: DeviceContext): Promise<void> {}

    async ioctl(_ctx: DeviceContext, command: string, arg?: unknown): Promise<unknown> {
        if (command === 'load' && typeof arg === 'string') return this.loadSkill(arg);
        if (command === 'list') return this.listSkills();
        throw new Error(`Unknown ioctl command: ${command}`);
    }

    // ── ISkillService — 基础 CRUD ──

    listSkills(): SkillDefinition[] {
        return [...new Map([...this.registry, ...this.fileSystemSkills]).values()];
    }

    getSkill(id: string): SkillDefinition | undefined {
        return this.fileSystemSkills.get(id) ?? this.registry.get(id);
    }

    getSkillNames(): string[] {
        return this.listSkills().map(skill => skill.id);
    }

    async loadSkill(id: string): Promise<SkillLoadResult> {
        const fail = (error: string): SkillLoadResult => ({ skillId: id, success: false, toolIds: [], error });
        if (this.closed) return fail('Skill service is closed');
        const skill = this.getSkill(id);
        if (!skill) return fail(`Skill not found: ${id}`);
        if (!skill.enabled) return fail(`Skill is disabled: ${id}`);
        if (!this.isSkillInScope(skill)) return fail(`Skill is outside the current scope: ${id}`);
        const revision = this.scopeRevision;
        const activationRevision = this.activationRevisions.get(id);
        let supporting: string;
        try { supporting = await skillSupportPrompt(skill, this.options.readFile); }
        catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
        if (this.closed || revision !== this.scopeRevision || activationRevision !== this.activationRevisions.get(id)
            || this.getSkill(id) !== skill || !this.isSkillInScope(skill)) return fail('Skill scope changed during loading');
        const current = createSkillVersionSnapshot(skill, [skill.instructions, supporting].filter(Boolean).join('\n\n'),
            aggregateCompactInstructions([skill]));
        let selected: SkillVersionSnapshot;
        try { selected = this.selectVersion(current); }
        catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
        return this.activateVersion(selected);
    }

    private selectVersion(current: SkillVersionSnapshot): SkillVersionSnapshot {
        const id = current.definition.id;
        const pinned = this.pins.get(id);
        if (pinned && pinned.digest !== current.digest) {
            const previous = this.drifts.get(id);
            this.drifts.set(id, { expectedDigest: pinned.digest, observedDigest: current.digest,
                detectedAt: previous?.observedDigest === current.digest ? previous.detectedAt : Date.now(), policy: pinned.policy });
            if (pinned.policy === 'require-reload' || !sameSkillAuthority(pinned.definition, current.definition)) {
                this.deactivateSkill(id);
                throw new Error(`Skill version or authority changed; reload required: ${id}`);
            }
        } else this.drifts.delete(id);
        return pinned ?? current;
    }

    private activateVersion(selected: SkillVersionSnapshot): SkillLoadResult {
        const id = selected.definition.id;
        if (this.snapshots.has(id) && this.snapshots.get(id)?.digest !== selected.digest) this.deactivateSkill(id);
        this.loaded.add(id);
        this.snapshots.set(id, selected);
        this.pins.set(id, selected);
        if (this.fileSystemSkills.has(id)) this.fileSystemLoadIntent.add(id);
        try {
            for (const binding of selected.definition.tools) this.registerDynamicTool(selected.definition, binding);
        } catch (error) {
            try { this.deactivateSkill(id); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Skill activation and cleanup failed'); }
            throw error;
        }
        return snapshotLoadResult(selected);
    }

    getSkillSnapshot(id: string): SkillVersionSnapshot | undefined {
        const snapshot = this.snapshots.get(id);
        return snapshot ? structuredClone(snapshot) : undefined;
    }

    getSkillDrifts(): Record<string, SkillVersionDrift> { return structuredClone(Object.fromEntries(this.drifts)); }

    async restoreSkillSnapshot(value: SkillVersionSnapshot): Promise<SkillLoadResult> {
        const snapshot = validateSkillVersionSnapshot(value);
        this.pins.set(snapshot.definition.id, snapshot);
        if (this.fileSystemSkills.has(snapshot.definition.id)) this.fileSystemLoadIntent.add(snapshot.definition.id);
        return this.loadSkill(snapshot.definition.id);
    }

    async reloadSkill(id: string): Promise<SkillLoadResult> {
        const previous = this.pins.get(id);
        this.pins.delete(id);
        try {
            const result = await this.loadSkill(id);
            if (result.success && result.snapshot) this.pins.set(id, result.snapshot);
            else if (previous) this.pins.set(id, previous);
            return result;
        } catch (error) { if (previous) this.pins.set(id, previous); throw error; }
    }

    async validateLoadedVersions(): Promise<void> {
        for (const id of this.pins.keys()) {
            const result = await this.loadSkill(id);
            if (!result.success) {
                this.deactivateSkill(id);
                throw new Error(result.error ?? `Skill version unavailable: ${id}`);
            }
        }
    }

    async unloadSkill(id: string): Promise<void> {
        this.fileSystemLoadIntent.delete(id);
        this.pins.delete(id);
        this.drifts.delete(id);
        this.deactivateSkill(id);
    }

    getLoadedSkills(): SkillDefinition[] {
        return [...this.loaded]
            .map((id) => this.getSkill(id)?.enabled ? this.snapshots.get(id)?.definition ?? this.getSkill(id) : undefined)
            .filter((s): s is SkillDefinition => s !== undefined && s.enabled && this.isSkillInScope(s));
    }

    getUnloadedSkills(): SkillDefinition[] {
        return this.getScopedSkills().filter((s) => !this.loaded.has(s.id) && s.enabled);
    }

    autoDetectSkills(prompt: string): string[] {
        return this.semanticMatchSkills(prompt);
    }

    async saveSkill(skill: SkillDefinition): Promise<void> {
        this.registry.set(skill.id, skill);
        this.notifyChange();
    }

    /**
     * 删除 skill。
     * 保护：source='filesystem' 的 skill 不受 VFS 同步删除影响。
     * VFS 同步调用时应先检查来源。
     */
    async deleteSkill(id: string): Promise<void> {
        const skill = this.getSkill(id);
        if (skill?.source === 'filesystem') return; // 文件系统 skill 不被 VFS 同步删除
        this.registry.delete(id);
        this.deactivateSkill(id);
        this.notifyChange();
    }

    onChange(listener: () => void): () => void {
        this.changeListeners.push(listener);
        return () => {
            const idx = this.changeListeners.indexOf(listener);
            if (idx >= 0) this.changeListeners.splice(idx, 1);
        };
    }

    getService(): ISkillService {
        return this;
    }

    // ── ISkillService — 四层路由 ──

    getRouteLayers(): SkillRouteLayer {
        const layers: SkillRouteLayer = {
            silent: [],
            index: [],
            dynamicMount: [],
            spatial: [],
        };

        for (const skill of this.getScopedSkills()) {
            if (!skill.enabled) continue;

            // L1: action skill with disableModelInvocation → silent
            if (skill.disableModelInvocation) {
                layers.silent.push(skill);
                continue;
            }

            const isLoaded = this.loaded.has(skill.id);
            const isGlobMounted = (this.globMounted.get(skill.id)?.size ?? 0) > 0;

            if (isLoaded && isGlobMounted) {
                layers.spatial.push(skill); // L4
            } else if (isLoaded) {
                layers.dynamicMount.push(skill); // L3
            } else {
                layers.index.push(skill); // L2
            }
        }

        return layers;
    }

    /**
     * 语义匹配，返回应加载的 skill id 列表。
     * 跳过 L1 action skill（disableModelInvocation=true）。
     * 优先级：triggerPatterns → 关键词重叠(≥2) → globs
     */
    semanticMatchSkills(userMessage: string, context?: SkillMatchContext): string[] {
        const matched = new Set<string>();
        const lowerMsg = userMessage.toLowerCase();
        const msgWords = lowerMsg.split(/\W+/).filter((w) => w.length > 2);

        for (const skill of this.getScopedSkills()) {
            if (!skill.enabled || skill.disableModelInvocation) continue;
            if (this.loaded.has(skill.id)) continue;

            // 1. triggerPatterns (regex, backward compat)
            if (skill.triggerPatterns.some((pattern) => {
                try { return new RegExp(pattern, 'i').test(userMessage); } catch { return false; }
            })) {
                matched.add(skill.id);
                continue;
            }

            // 2. Keyword overlap: ≥2 words from description appear in message
            const descWords = skill.description.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
            const overlap = [...new Set(descWords)].filter((w) => msgWords.includes(w));
            if (overlap.length >= 2) {
                matched.add(skill.id);
                continue;
            }

            // 3. Glob match against openFiles context
            if (context?.openFiles?.length && skill.globs?.length) {
                if (context.openFiles.some((f) => matchGlob(f, skill.globs!))) {
                    matched.add(skill.id);
                }
            }
        }

        return [...matched];
    }

    mountByGlob(filePath: string): void {
        if (this.closed) return;
        for (const skill of this.getScopedSkills()) {
            if (!skill.enabled || skill.disableModelInvocation || !skill.globs?.length) continue;
            if (matchGlob(filePath, skill.globs)) {
                if (!this.globMounted.has(skill.id)) {
                    this.globMounted.set(skill.id, new Set());
                }
                this.globMounted.get(skill.id)!.add(filePath);
                this.loaded.add(skill.id);
            }
        }
    }

    unmountByGlob(filePath: string): void {
        for (const [skillId, files] of this.globMounted) {
            files.delete(filePath);
            if (files.size === 0) {
                this.globMounted.delete(skillId);
                this.deactivateSkill(skillId);
            }
        }
    }

    async registerFromDirectory(
        dirPath: string,
        scopeLevel: SkillScopeLevel,
        scopeRoot: string
    ): Promise<SkillLoadResult[]> {
        if (this.closed) throw new Error('Skill service is closed');
        const loader = this.options.source?.loadDirectory;
        if (!loader) return [];
        const revision = this.scopeRevision;
        const skills = await loader(dirPath, scopeLevel, scopeRoot);
        if (revision !== this.scopeRevision) return [];
        return this.replaceFileSystemSkills(skills, false);
    }

    // ── ISkillService — Compact Instructions ──

    parseCompactInstructions(skillId: string): ParsedCompactInstructions {
        const skill = this.getSkill(skillId);
        if (!skill?.compact) return { redLines: [], fullText: '' };
        const { redLines, rawContent } = skill.compact;
        return { redLines, fullText: rawContent };
    }

    getCompactInstructions(): string {
        return aggregateCompactInstructions(this.getLoadedSkills().filter(skill => !skill.disableModelInvocation));
    }

    // ── ISkillService — 作用域管理 ──

    getAgentMdContent(): string {
        return this.agentMdContent;
    }

    async setCwd(cwd: string): Promise<void> {
        if (cwd !== this.cwd) this.fileSystemLoadIntent.clear();
        this.cwd = cwd;
        for (const id of [...this.loaded]) {
            const skill = this.getSkill(id);
            if (!skill || !this.isSkillInScope(skill)) this.deactivateSkill(id);
        }
        await this.refreshScopedSkills();
    }

    getScopedSkills(): SkillDefinition[] {
        return this.listSkills().filter((s) => this.isSkillInScope(s));
    }

    async refreshScopedSkills(): Promise<SkillLoadResult[]> {
        if (this.closed) throw new Error('Skill service is closed');
        if (!this.options.source) return [];
        const revision = ++this.scopeRevision;
        this.agentMdContent = '';
        this.replaceFileSystemSkills([], true);
        const snapshot = await this.options.source.loadScope(this.cwd);
        if (revision !== this.scopeRevision) return [];
        this.agentMdContent = snapshot.agentInstructions;
        const results = this.replaceFileSystemSkills(snapshot.skills, true);
        for (const id of [...this.fileSystemLoadIntent]) {
            if (revision !== this.scopeRevision) return [];
            const skill = this.fileSystemSkills.get(id);
            if (!skill?.enabled || skill.disableModelInvocation || !this.isSkillInScope(skill)) {
                results.push({ skillId: id, success: false, toolIds: [], error: `Loaded Skill is unavailable or unauthorized: ${id}` });
                continue;
            }
            const result = await this.loadSkill(id);
            if (revision !== this.scopeRevision) return [];
            const index = results.findIndex(item => item.skillId === id);
            if (index >= 0) results[index] = result;
        }
        return results;
    }

    // ── 私有工具 ──

    /**
     * 判断 skill 是否在当前作用域内可见（设计文档 6.3 节）。
     */
    private isSkillInScope(skill: SkillDefinition): boolean {
        const level = skill.scopeLevel;
        // VFS skills and skills without scope are always visible
        if (!level || level === 'vfs' || level === 'global-fs') return true;

        if (!skill.scopeRoot || !this.cwd) return false;
        const scopeRoot = skill.scopeRoot.replace(/\/+$/, '') || '/';
        const cwd = this.cwd.replace(/\/+$/, '') || '/';
        if (level === 'local-fs') {
            return cwd === scopeRoot;
        }

        // parent-fs: scopeRoot must be an ancestor of cwd
        return cwd === scopeRoot || cwd.startsWith(scopeRoot === '/' ? '/' : scopeRoot + '/');
    }

    private registerDynamicTool(skill: SkillDefinition, binding: SkillToolBinding): void {
        if (!this.toolService || binding.executionType === 'builtin') return;
        if (this.toolService.getToolMeta(binding.toolId)) return;
        const handler = this.options.toolHandlerFactory?.create(skill, binding);
        if (!handler) throw new Error(`No tool handler registered for ${skill.id}/${binding.toolId} (${binding.executionType})`);
        this.toolService.registerTool(toolMeta(skill, binding), binding.definition, handler);
        const owned = this.registeredTools.get(skill.id) ?? new Set<string>();
        owned.add(binding.toolId);
        this.registeredTools.set(skill.id, owned);
    }

    private deactivateSkill(id: string): void {
        this.activationRevisions.set(id, (this.activationRevisions.get(id) ?? 0) + 1);
        this.loaded.delete(id);
        this.snapshots.delete(id);
        this.globMounted.delete(id);
        for (const toolId of this.registeredTools.get(id) ?? []) {
            this.toolService?.unregisterTool(toolId);
        }
        this.registeredTools.delete(id);
    }

    private replaceFileSystemSkills(skills: SkillDefinition[], replace: boolean): SkillLoadResult[] {
        if (replace) {
            for (const id of this.fileSystemSkills.keys()) this.deactivateSkill(id);
            this.fileSystemSkills.clear();
        }
        for (const skill of skills) {
            this.deactivateSkill(skill.id);
            this.fileSystemSkills.set(skill.id, skill);
        }
        if (skills.length > 0 || replace) this.notifyChange();
        return skills.map(skill => ({ skillId: skill.id, success: true, toolIds: [] }));
    }

    private notifyChange(): void {
        for (const l of this.changeListeners) l();
    }
}

function toolMeta(skill: SkillDefinition, binding: SkillToolBinding): import('@itookit/tools/contracts').ToolMeta {
    return {
        id: binding.toolId,
        name: binding.definition.function?.name ?? binding.definition.name ?? binding.toolId,
        description: binding.definition.function?.description ?? skill.description,
        sideEffect: binding.sideEffect ?? (['http', 'mcp'].includes(binding.executionType) || skill.type === 'mcp' ? 'external' : 'local'),
        timeoutMs: binding.timeoutMs ?? 30_000,
        type: 'plugin',
        enabled: true,
    };
}

/** A retained prompt must never retain removed bindings or switch its source authority. */
function sameSkillAuthority(previous: SkillDefinition, current: SkillDefinition): boolean {
    const authority = (skill: SkillDefinition) => ({ source: skill.source, scopeLevel: skill.scopeLevel,
        scopeRoot: skill.scopeRoot, fsRoot: skill.fsRoot, tools: skill.tools, endpoint: skill.endpoint,
        method: skill.method, headers: skill.headers, command: skill.command,
        mcpServerId: skill.mcpServerId, mcpToolName: skill.mcpToolName, taskProgram: skill.taskProgram,
        disableModelInvocation: skill.disableModelInvocation, triggerStrategy: skill.triggerStrategy });
    return JSON.stringify(authority(previous)) === JSON.stringify(authority(current));
}
