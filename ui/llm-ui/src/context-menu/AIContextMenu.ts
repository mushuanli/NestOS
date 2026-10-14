/**
 * @file llm-ui/context-menu/AIContextMenu.ts
 * @desc Extends the VFS file-tree context menu with AI-specific actions:
 *       binding a default Agent and setting an initial prompt on any node.
 *
 * Usage:
 * ```ts
 * import { createAIContextMenuConfig } from '@itookit/llm-ui';
 *
 * // Pass to VFSUIShell via MemoryManagerConfig.uiOptions
 * uiOptions: {
 *   contextMenu: createAIContextMenuConfig({ agentService, engine }),
 * }
 * ```
 */
import type { IAgentConfigService, AgentDefinition } from '@itookit/kernel-adapters/contracts';
import type { ContextMenuConfig, MenuItem } from '@itookit/ui-common';
import type { IFileSystem } from '@itookit/vfs-core';
import { escapeHTML, escapeAttr } from '@itookit/common';

// Matches the shape of VFSNodeUI exposed via the ContextMenuBuilder callback.
// Avoids a hard dependency on @itookit/vfs-ui.
interface NodeItem {
    id: string;
    type: 'file' | 'directory';
    metadata: {
        title: string;
        custom: Record<string, unknown>;
    };
}

export interface AIContextMenuOptions {
    /** Agent service used to load the list of available agents. */
    agentService: IAgentConfigService;
    /** Session engine used to persist metadata changes. */
    engine: IFileSystem;
    /**
     * When true, AI items are hidden for file nodes (show only on directories).
     * Directories are the primary target: ai_defaultAgent and ai_initialPrompt
     * set on a directory are inherited by all new sessions created inside it.
     * @default false  (show on both files and directories)
     */
    filesOnly?: boolean;
}

/**
 * Returns a ContextMenuConfig that appends AI-related items to the file-tree
 * context menu.
 *
 * Semantics by node type:
 *  - Directory: ai_defaultAgent + ai_initialPrompt (inherited by new sessions created inside)
 *  - File (.chat): ai_systemPrompt (overrides the agent's systemPrompt for this session only)
 */
export function createAIContextMenuConfig<TNode extends NodeItem>(
    options: AIContextMenuOptions,
): ContextMenuConfig<TNode> {
    const { agentService, engine } = options;

    return {
        items: (node: TNode, defaultItems: MenuItem<TNode>[]): MenuItem<TNode>[] => {
            const isDir = node.type === 'directory';

            const aiItems: MenuItem<TNode>[] = [{ type: 'separator' }];

            if (isDir) {
                // Directory: configure defaults inherited by new sessions inside
                const currentAgentId = node.metadata.custom?.ai_defaultAgent as string | undefined;
                const currentPrompt  = node.metadata.custom?.ai_initialPrompt as string | undefined;

                aiItems.push(
                    {
                        id: 'ai:setAgent',
                        label: currentAgentId ? '🤖 默认 Agent（已设置）' : '🤖 设置默认 Agent...',
                        onClick: () => showAgentDialog(node, agentService, engine, currentAgentId),
                    },
                    {
                        id: 'ai:setInitialPrompt',
                        label: currentPrompt ? '💬 新建提示（已设置）' : '💬 设置新建提示...',
                        onClick: () => showInitialPromptDialog(node, engine, currentPrompt),
                    }
                );
            } else {
                // File: override system prompt for this specific chat session
                const currentSystemPrompt = node.metadata.custom?.ai_systemPrompt as string | undefined;

                aiItems.push({
                    id: 'ai:setSystemPrompt',
                    label: currentSystemPrompt ? '🔧 系统提示（已自定义）' : '🔧 自定义系统提示...',
                    onClick: () => showSystemPromptDialog(node, engine, currentSystemPrompt),
                });
            }

            return [...defaultItems, ...aiItems];
        },
    };
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

async function showAgentDialog(
    node: NodeItem,
    agentService: IAgentConfigService,
    engine: IFileSystem,
    currentAgentId: string | undefined
): Promise<void> {
    let agents: AgentDefinition[] = [];
    try {
        agents = await agentService.getAgents();
    } catch {
        // Render with empty list; user can still clear or cancel.
    }

    const DEFAULT_AGENT: AgentDefinition = {
        id: 'default',
        name: 'Default Assistant',
        icon: '🤖',
        type: 'agent',
        description: '系统默认 AI 助手',
        config: {},
    };
    const allAgents = [DEFAULT_AGENT, ...agents.filter(a => a.id !== 'default')];

    let selectedId = currentAgentId ?? 'default';

    const overlay = createOverlay();
    const dialog  = document.createElement('div');
    dialog.className = 'ai-cm-dialog';
    dialog.innerHTML = `
        <div class="ai-cm-dialog__header">
            <div class="ai-cm-dialog__title">🤖 设置默认 Agent</div>
            <div class="ai-cm-dialog__subtitle">
                「${escapeHTML(node.metadata.title)}」目录下新建的会话将自动使用此 Agent
            </div>
        </div>
        <div class="ai-cm-dialog__body">
            <div class="ai-cm-agent-list">
                ${allAgents.map(a => `
                    <div class="ai-cm-agent-item${a.id === selectedId ? ' is-selected' : ''}"
                         data-agent-id="${escapeAttr(a.id)}">
                        <div class="ai-cm-agent-item__icon">${escapeHTML(a.icon || '🤖')}</div>
                        <div class="ai-cm-agent-item__info">
                            <div class="ai-cm-agent-item__name">${escapeHTML(a.name)}</div>
                            ${a.description
                                ? `<div class="ai-cm-agent-item__desc">${escapeHTML(a.description)}</div>`
                                : ''}
                        </div>
                        <span class="ai-cm-agent-item__check" aria-hidden="true">✓</span>
                    </div>
                `).join('')}
            </div>
            ${currentAgentId
                ? `<div class="ai-cm-clear-row">
                       <button class="ai-cm-btn-link" data-action="clear">清除绑定</button>
                   </div>`
                : ''}
        </div>
        <div class="ai-cm-dialog__footer">
            <button class="ai-cm-btn ai-cm-btn--secondary" data-action="cancel">取消</button>
            <button class="ai-cm-btn ai-cm-btn--primary"   data-action="confirm">确认</button>
        </div>
    `;

    dialog.querySelectorAll<HTMLElement>('.ai-cm-agent-item').forEach(el => {
        el.addEventListener('click', () => {
            dialog.querySelectorAll('.ai-cm-agent-item').forEach(i => i.classList.remove('is-selected'));
            el.classList.add('is-selected');
            selectedId = el.dataset.agentId!;
        });
    });

    dialog.querySelector('[data-action="clear"]')?.addEventListener('click', async () => {
        await engine.driver.updateMetadata(node.id, { ai_defaultAgent: undefined });
        overlay.remove();
    });

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
        overlay.remove();
    });

    dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
        await engine.driver.updateMetadata(node.id, { ai_defaultAgent: selectedId });
        overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function showInitialPromptDialog(
    node: NodeItem,
    engine: IFileSystem,
    currentPrompt: string | undefined
): void {
    const overlay = createOverlay();
    const dialog  = document.createElement('div');
    dialog.className = 'ai-cm-dialog';
    dialog.innerHTML = `
        <div class="ai-cm-dialog__header">
            <div class="ai-cm-dialog__title">💬 设置新建提示</div>
            <div class="ai-cm-dialog__subtitle">
                「${escapeHTML(node.metadata.title)}」目录下新建的会话将自动发送此提示
            </div>
        </div>
        <div class="ai-cm-dialog__body">
            <textarea class="ai-cm-textarea"
                      placeholder="输入新建会话时自动发送给 Agent 的第一条提示..."
            >${escapeHTML(currentPrompt || '')}</textarea>
            <p class="ai-cm-help">
                💡 在此目录下新建会话时，此提示将作为第一条消息自动发送
            </p>
        </div>
        <div class="ai-cm-dialog__footer">
            ${currentPrompt
                ? `<button class="ai-cm-btn ai-cm-btn--danger" data-action="clear">清除提示</button>`
                : ''}
            <button class="ai-cm-btn ai-cm-btn--secondary" data-action="cancel">取消</button>
            <button class="ai-cm-btn ai-cm-btn--primary"   data-action="confirm">保存</button>
        </div>
    `;

    const textarea = dialog.querySelector<HTMLTextAreaElement>('.ai-cm-textarea')!;
    setTimeout(() => textarea?.focus(), 50);

    dialog.querySelector('[data-action="clear"]')?.addEventListener('click', async () => {
        await engine.driver.updateMetadata(node.id, { ai_initialPrompt: undefined });
        overlay.remove();
    });

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
        overlay.remove();
    });

    dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
        const text = textarea.value.trim();
        await engine.driver.updateMetadata(node.id, { ai_initialPrompt: text || undefined });
        overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function showSystemPromptDialog(
    node: NodeItem,
    engine: IFileSystem,
    currentPrompt: string | undefined
): void {
    const overlay = createOverlay();
    const dialog  = document.createElement('div');
    dialog.className = 'ai-cm-dialog';
    dialog.innerHTML = `
        <div class="ai-cm-dialog__header">
            <div class="ai-cm-dialog__title">🔧 自定义系统提示</div>
            <div class="ai-cm-dialog__subtitle">
                为「${escapeHTML(node.metadata.title)}」单独设置 System Prompt，优先于 Agent 配置
            </div>
        </div>
        <div class="ai-cm-dialog__body">
            <textarea class="ai-cm-textarea"
                      placeholder="You are a helpful assistant..."
                      style="min-height:160px"
            >${escapeHTML(currentPrompt || '')}</textarea>
            <p class="ai-cm-help">
                💡 设置后此会话将使用此 System Prompt 替代 Agent 自身的配置；
                清除后恢复使用 Agent 的 System Prompt
            </p>
        </div>
        <div class="ai-cm-dialog__footer">
            ${currentPrompt
                ? `<button class="ai-cm-btn ai-cm-btn--danger" data-action="clear">恢复 Agent 默认</button>`
                : ''}
            <button class="ai-cm-btn ai-cm-btn--secondary" data-action="cancel">取消</button>
            <button class="ai-cm-btn ai-cm-btn--primary"   data-action="confirm">保存</button>
        </div>
    `;

    const textarea = dialog.querySelector<HTMLTextAreaElement>('.ai-cm-textarea')!;
    setTimeout(() => textarea?.focus(), 50);

    dialog.querySelector('[data-action="clear"]')?.addEventListener('click', async () => {
        await engine.driver.updateMetadata(node.id, { ai_systemPrompt: undefined });
        overlay.remove();
    });

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
        overlay.remove();
    });

    dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
        const text = textarea.value.trim();
        await engine.driver.updateMetadata(node.id, { ai_systemPrompt: text || undefined });
        overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function createOverlay(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ai-cm-overlay';
    return el;
}
