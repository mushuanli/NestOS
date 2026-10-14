// @file: llm-ui/editors/llm-import.ts
//
// Shared import logic for .llm bundle files.
//
// Handles:
//   - Conflict detection (providers / connections / agents / skills)
//   - Conflict resolution modal (skip / overwrite / rename)
//   - Cascading ID remapping on rename (provider → connections)
//   - Executing the import in dependency order

import { Toast } from '@itookit/ui-common';
import type { IConnectionService } from '@itookit/kernel-adapters/contracts';
import { Modal } from '@itookit/ui-common';
import {
    parseLLMConfig,
    getProviderDefs,
    type LLMConfigFile,
} from '@itookit/kernel-adapters/llm/config';

import type { ConflictStrategy, ConflictItem, ImportStats, ConfigurationImportPort } from '@itookit/kernel-adapters/contracts';
export type { ConflictStrategy, ConflictItem, ImportStats } from '@itookit/kernel-adapters/contracts';

function importPort(service: IConnectionService): ConfigurationImportPort {
    const port = service as IConnectionService & Partial<ConfigurationImportPort>;
    if (!port.previewConfigurationImport || !port.importConfiguration) throw new Error('Configuration import capability is unavailable');
    return port as ConfigurationImportPort;
}

export function detectConflicts(config: LLMConfigFile, service: IConnectionService): Promise<ConflictItem[]> {
    return importPort(service).previewConfigurationImport(config);
}
export function executeImport(config: LLMConfigFile, service: IConnectionService, strategy: ConflictStrategy): Promise<ImportStats> {
    return importPort(service).importConfiguration(config, strategy);
}

// ─── Conflict resolution modal ────────────────────────────────────────────────

const TYPE_LABELS: Record<ConflictItem['type'], string> = {
    provider: 'Provider',
    connection: '连接',
    agent: 'Agent',
    skill: 'Skill',
};

/**
 * Show a conflict resolution modal.
 * Resolves with the chosen strategy, or `null` if user cancels.
 */
export function showConflictModal(conflicts: ConflictItem[]): Promise<ConflictStrategy | null> {
    return new Promise((resolve) => {
        const grouped: Partial<Record<ConflictItem['type'], ConflictItem[]>> = {};
        for (const c of conflicts) {
            (grouped[c.type] ??= []).push(c);
        }

        const listHtml = (Object.entries(grouped) as [ConflictItem['type'], ConflictItem[]][])
            .map(([type, items]) => `
                <div style="margin-bottom:8px">
                    <strong>${TYPE_LABELS[type]}</strong>：
                    ${items.map(i => `<code style="font-size:.8rem;background:var(--st-bg-secondary,#f5f5f5);padding:1px 4px;border-radius:3px">${i.id}</code>`).join(' ')}
                </div>
            `).join('');

        const body = `
            <p style="margin:0 0 12px;font-size:.875rem;color:var(--st-text-secondary)">
                发现 <strong>${conflicts.length}</strong> 个 ID 与现有配置冲突：
            </p>
            <div style="margin-bottom:16px;padding:10px 12px;background:var(--st-bg-secondary,#f8f8f8);border-radius:6px;font-size:.85rem">
                ${listHtml}
            </div>
            <fieldset style="border:none;padding:0;margin:0">
                <legend style="font-size:.875rem;font-weight:600;margin-bottom:8px">处理方式</legend>
                <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;cursor:pointer">
                    <input type="radio" name="conflict-strategy" value="skip" style="margin-top:3px">
                    <span>
                        <strong>跳过</strong>
                        <span style="display:block;font-size:.8rem;color:var(--st-text-secondary)">保留现有配置，仅导入不冲突的项目</span>
                    </span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;cursor:pointer">
                    <input type="radio" name="conflict-strategy" value="overwrite" checked style="margin-top:3px">
                    <span>
                        <strong>覆盖</strong>
                        <span style="display:block;font-size:.8rem;color:var(--st-text-secondary)">用导入内容替换现有配置（API Key 不受影响）</span>
                    </span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                    <input type="radio" name="conflict-strategy" value="rename" style="margin-top:3px">
                    <span>
                        <strong>重命名</strong>
                        <span style="display:block;font-size:.8rem;color:var(--st-text-secondary)">自动为导入项追加 -2、-3 后缀，与现有并存</span>
                    </span>
                </label>
            </fieldset>
        `;

        new Modal('导入冲突', body, {
            confirmText: '确认导入',
            width: '480px',
            onConfirm: () => {
                const radio = document.querySelector(
                    'input[name="conflict-strategy"]:checked',
                ) as HTMLInputElement | null;
                resolve((radio?.value as ConflictStrategy) ?? 'overwrite');
            },
            onCancel: () => resolve(null),
        }).show();
    });
}

// ─── YAML error formatting ────────────────────────────────────────────────────

/**
 * Translate js-yaml errors into user-friendly Chinese messages with fix guidance.
 * Uses file content to provide line context and expected indentation.
 */
function formatYAMLError(fileName: string, err: unknown, fileContent: string): string {
    const message = err instanceof Error ? err.message : String(err);

    // Detect indentation errors — the most common .llm editing mistake
    if (message.includes('bad indentation')) {
        const lineMatch = message.match(/\((\d+):/);
        if (lineMatch) {
            const lineNum = parseInt(lineMatch[1]);
            const lines = fileContent.split('\n');
            const badLine = lines[lineNum - 1] || '';
            const actualIndent = badLine.match(/^(\s*)/)?.[1].length ?? 0;

            // Find expected indentation from preceding sibling list items
            let expectedIndent = 2;
            for (let i = lineNum - 2; i >= 0 && i >= lineNum - 10; i--) {
                const m = lines[i]?.match(/^(\s*)-/);
                if (m) { expectedIndent = m[1].length; break; }
            }

            return [
                `${fileName}: YAML 缩进错误`,
                `  第 ${lineNum} 行缩进 ${actualIndent} 空格，应为 ${expectedIndent} 空格（与同级条目一致）`,
                `  出错行: ${badLine.trim()}`,
                `  请将该行及子属性的缩进增加 ${expectedIndent - actualIndent} 个空格`,
            ].join('\n');
        }
    }

    // Generic YAML errors — extract line number if present
    const genericMatch = message.match(/at line\s+(\d+)|\((\d+)[,:]/);
    if (genericMatch) {
        const lineNum = parseInt(genericMatch[1] || genericMatch[2]);
        const lines = fileContent.split('\n');
        const contextLine = lines[lineNum - 1]?.trim() || '';
        return [
            `${fileName}: YAML 语法错误 (第 ${lineNum} 行)`,
            `  内容: ${contextLine}`,
            `  原因: ${message}`,
        ].join('\n');
    }

    return `${fileName}: ${message}`;
}

// ─── Main entry: parse files + detect + show modal + execute ─────────────────

/**
 * Full import flow: parse .llm files → detect conflicts → resolve → execute.
 * Call this from editor `importLLMFiles` handlers.
 *
 * Returns `true` if import completed (even partially), `false` if user cancelled.
 */
export async function runLLMImport(
    files: FileList,
    service: IConnectionService,
): Promise<boolean> {
    // Parse all files, merge into one config
    const merged: LLMConfigFile = {
        providers: [],
        connections: [],
        agents: [],
        skills: [],
    };
    const errors: string[] = [];

    for (const file of Array.from(files)) {
        const text = await file.text();
        try {
            const config = parseLLMConfig(text);
            merged.providers!.push(...getProviderDefs(config));
            merged.connections!.push(...(config.connections ?? []));
            merged.agents!.push(...(config.agents ?? []));
            merged.skills!.push(...(config.skills ?? []));
        } catch (err) {
            errors.push(formatYAMLError(file.name, err, text));
        }
    }

    if (errors.length) {
        const msg = `文件解析失败:\n${errors.join('\n')}`;
        console.error('LLM import parse errors:', errors);
        Toast.error(msg);
        return false;
    }

    // Validate that at least one importable item exists
    const hasProviders   = (merged.providers?.length ?? 0) > 0;
    const hasConnections = (merged.connections?.length ?? 0) > 0;
    const hasAgents      = (merged.agents?.length ?? 0) > 0;
    const hasSkills      = (merged.skills?.length ?? 0) > 0;
    if (!hasProviders && !hasConnections && !hasAgents && !hasSkills) {
        Toast.error('文件中未找到可导入的 Provider、连接、Agent 或 Skill');
        return false;
    }

    // Detect conflicts
    let conflicts: ConflictItem[];
    try {
        conflicts = await detectConflicts(merged, service);
    } catch (err) {
        console.error('LLM import conflict detection failed:', err);
        Toast.error(`导入冲突检测失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }

    let strategy: ConflictStrategy = 'overwrite';
    if (conflicts.length > 0) {
        const chosen = await showConflictModal(conflicts);
        if (chosen === null) return false;  // user cancelled
        strategy = chosen;
    }

    // Execute
    let stats: ImportStats;
    try {
        stats = await executeImport(merged, service, strategy);
    } catch (err) {
        console.error('LLM import execution failed:', err);
        Toast.error(`导入执行失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }

    // Toast result
    const parts: string[] = [];
    if (stats.providers)   parts.push(`${stats.providers} 个 Provider`);
    if (stats.connections) parts.push(`${stats.connections} 个连接`);
    if (stats.agents)      parts.push(`${stats.agents} 个 Agent`);
    if (stats.skills)      parts.push(`${stats.skills} 个 Skill`);
    if (stats.skipped)     parts.push(`${stats.skipped} 项已跳过`);

    if (parts.length) Toast.success(`导入完成：${parts.join('，')}`);
    else Toast.success('导入完成（无新内容）');

    return true;
}
