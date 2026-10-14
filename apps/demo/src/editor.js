/**
 * #demo/editor-demo.js
 * @file Demo showcasing the new plugin-based architecture for the MDx library.
 */
import '@itookit/mdxeditor/style.css';

// [新增] CodeMirror 6 独立演示所需的导入
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";

import {IMentionSource,simpleHash} from '@itookit/common';
// [修改] 现有 MDxEditor 库的导入
import {
    createMDxEditor,      // [修改] 导入新的工厂函数替代 MDxEditor 构造函数
    MDxEditor,            // [保留] 保留 MDxEditor 类型用于 JSDoc 和类型提示
    MDxRenderer,
    MDxProcessor,
    // [移除] 不再需要 defaultPlugins，工厂函数会自动处理
    // We still import individual plugins if needed for custom renderers or advanced setups
    MentionPlugin,
    // [新增] 导入用于独立渲染器的插件
    FoldablePlugin,
    MathJaxPlugin,
    MediaPlugin,
    MermaidPlugin,
    ClozePlugin,
    TaskListPlugin,
    // Import keys for services
} from '@itookit/mdxeditor';

/**
 * @typedef {import('@itookit/mdxeditor').MDxPlugin} MDxPlugin
 * @typedef {import('@itookit/mdxeditor').PluginContext} PluginContext
 */

// 使用 Set 来跟踪需要永久打开的 Cloze
const permanentlyOpenClozes = new Set();

// [NEW] 为 Mention 插件定义一个唯一的服务 Key
const MentionAPIKey = Symbol('MentionAPI');

/**
 * A plugin to manage Anki-like feedback UI and state.
 * @implements {MDxPlugin}
 */
class AnkiFeedbackPlugin {
    name = 'demo:anki-feedback';

    /** @param {PluginContext} context */
    install(context) {
        // 监听由 ClozePlugin 发出的事件
        context.listen('clozeRevealed', this.handleClozeRevealed.bind(this));
        
        // 监听渲染开始前的钩子，动态修改 clozeStates
        context.on('beforeParse', this.modifyClozeStates.bind(this));
    }

    /**
     * Hook to dynamically set clozes to be open based on our internal state.
     * @param {{ markdown: string, options: any }} payload
     */
    modifyClozeStates(payload) {
        // 确保 payload 结构完整
        if (!payload) {
            payload = { markdown: '', options: {} };
        }
        if (!payload.options) {
            payload.options = {};
        }
        
        const { options } = payload;
        
        // 确保 clozeStates 属性存在
        if (!options.clozeStates) {
            options.clozeStates = {};
        }
        
        // 设置永久打开的 cloze 状态
        for (const clozeId of permanentlyOpenClozes) {
            options.clozeStates[clozeId] = { 
                ...options.clozeStates[clozeId], 
                isHidden: false 
            };
        }
        
        return payload;
    }



    /**
     * Event handler for when a cloze is revealed.
     * [重构] 该方法现在变得极其简洁，因为它直接使用了事件载荷中提供的 `hide` 函数。
     * @param {{ clozeId: string, element: HTMLElement, content: string, hide: () => void }} detail
     */
    handleClozeRevealed(detail) {
        const outputContainer = detail.element.closest('#anki-output');
        if (!outputContainer) return;

        outputContainer.querySelector('.feedback-ui')?.remove();

        const feedbackUI = document.createElement('div');
        feedbackUI.className = 'feedback-ui';
        feedbackUI.innerHTML = `<button>重来</button><button>困难</button><button>犹豫</button><button>简单</button>`;
        detail.element.after(feedbackUI);

        feedbackUI.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLButtonElement)) return;
    
            const choice = target.textContent;
            const clozeId = detail.clozeId;
            
            alert(`你将 "${detail.content}" 评为 "${choice}"`);
            
            if (choice === '简单') {
                permanentlyOpenClozes.add(clozeId);
            } else {
                permanentlyOpenClozes.delete(clozeId);
                
                // [核心改进] 直接调用事件载荷中提供的 `hide` 函数，无需了解内部实现。
                detail.hide(); 
            }
            
            feedbackUI.remove();
        }, { once: true });
    }
}


// ======================================================
//   [NEW] Mention System Demo Setup
// ======================================================

// 1. Mock a database of files/users
let mockDatabase = {
    files: new Map([
        ['doc-1', { id: 'doc-1', title: 'Project Proposal', content: `## Project Proposal\n\nThis document outlines the plan for the new **MDxEditor**.` }],
        ['doc-2', { id: 'doc-2', title: 'Meeting Notes', content: `- Attended: @user:alice\n- Discussed: Finalizing the @mention feature.` }],
        ['doc-3', { id: 'doc-3', title: 'Technical Spec', content: `The core of the system is the **Provider Pattern**.` }],
    ]),
    users: new Map([
        ['alice', { id: 'alice', name: 'Alice', role: 'Lead Developer' }],
        ['bob', { id: 'bob', name: 'Bob', role: 'UX Designer' }],
    ]),
};

// 2. Create custom Mention Providers
class FileMentionProvider extends IMentionSource {
    key = 'file';
    triggerChar = '@'; // 明确指定触发字符
    async getSuggestions(query) {
        const lowerQuery = query.toLowerCase();
        return Array.from(mockDatabase.files.values())
            .filter(file => file.title.toLowerCase().includes(lowerQuery))
            .map(file => ({ id: file.id, label: `📄 ${file.title}` }));
    }

    async handleClick(targetURL) {
        const fileId = targetURL.pathname.substring(1); // remove leading '/'
        const file = mockDatabase.files.get(fileId);
        if (file) alert(`Navigating to file: "${file.title}"`);
    }
    /**
     * @param {URL} uri
     * @returns {Promise<{title: string, contentHTML: string, icon?: string} | null>}
     */
    async getHoverPreview(uri) {
        try {
            const fileId = uri.pathname.slice(1);
            const fileData = mockDatabase.files.get(fileId); // FIXED: Use mockDatabase directly
            
            if (!fileData) return null;
            
            return {
                title: fileData.title, // FIXED: Use correct property name
                contentHTML: `<div class="file-preview">
                    <p>Content: ${this._escapeHTML(fileData.content.substring(0, 100))}...</p>
                </div>`,
                icon: '<i class="fas fa-file"></i>'
            };
        } catch (error) {
            console.error('Error getting file preview:', error);
            return null;
        }
    }
    
    // [新增] 实现数据获取接口
    async getDataForProcess(targetURL) {
        const fileId = targetURL.pathname.substring(1);
        return mockDatabase.files.get(fileId) || null;
    }

    async getContentForTransclusion(targetURL) {
        const fileId = targetURL.pathname.substring(1);
        return mockDatabase.files.get(fileId)?.content || null;
    }
    
    _escapeHTML(str) {
        return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
}

class UserMentionProvider extends IMentionSource {
    key = 'user';
    triggerChar = '@';
    
    async getSuggestions(query) {
        const lowerQuery = query.toLowerCase();
        return Array.from(mockDatabase.users.values())
            .filter(user => user.name.toLowerCase().includes(lowerQuery))
            .map(user => ({ id: user.id, label: `🧑 ${user.name}` }));
    }

    /**
     * @param {URL} uri
     * @returns {Promise<{title: string, contentHTML: string, icon?: string} | null>}
     */
    async getHoverPreview(uri) {
        try {
            const userId = uri.pathname.slice(1);
            const user = mockDatabase.users.get(userId);
            
            if (!user) return null;
            
            return {
                title: user.name,
                contentHTML: `<div class="user-preview">
                    <p>Role: ${this._escapeHTML(user.role)}</p>
                </div>`,
                icon: '<i class="fas fa-user"></i>'
            };
        } catch (error) {
            console.error('Error getting user preview:', error);
            return null;
        }
    }

    async getDataForProcess(targetURL) {
        const userId = targetURL.pathname.substring(1);
        return mockDatabase.users.get(userId) || null;
    }
    _escapeHTML(str) {
        return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
}

/**
 * 一个本地实现的 Mention 插件，用于在 demo 中验证库的设计。
 * 它复刻了库中 MentionPlugin 的核心架构，证明其设计的易于实现性。
 */
class DemoMentionPlugin {
    name = 'demo:mention';
    providers = new Map();
    context = null;

    previewCardEl = null;
    debouncedGetHoverPreview;

    /**
     * @param {{ providers: IMentionSource[] }} options 
     */
    constructor(options = { providers: [] }) {
        (options.providers || []).forEach(p => {
            if (!p.key) throw new Error(`A mention provider (${p.constructor.name}) is missing the 'key' property.`);
            this.providers.set(p.key, p);
        });
        this.debouncedGetHoverPreview = this._debounce(this._getHoverPreview.bind(this), 300);
    }
    
    /**
     * @param {PluginContext} context 
     */
    install(context) {
        this.context = context;

        context.registerCodeMirrorExtension(autocompletion({ override: [this.createAutocompleteSource()] }));
        context.registerSyntaxExtension(this._createLinkRendererExtension());
        // @ts-ignore
        context.registerSyntaxExtension(this._createTransclusionExtension());
        context.on('domUpdated', ({ element }) => this._attachEventListeners(element));

        // [修改] 注册一个命令，供外部调用
        context.registerCommand('updateMentionLabel', (payload) => {
            this._handleExternalUpdate(payload);
        });

        context.provide(MentionAPIKey, {
            handleExternalUpdate: (payload) => this._handleExternalUpdate(payload)
        });
    }

    // --- 自动补全逻辑 ---
    createAutocompleteSource() {
        return async (cmContext) => {
            const match = cmContext.matchBefore(/@(\w*)$/);
            if (!match) return null;
            const query = match.text.substring(1);
            let allSuggestions = [];
            for (const provider of this.providers.values()) {
                if (provider.triggerChar === '@') {
                    const providerSuggestions = await provider.getSuggestions(query);
                    allSuggestions.push(...providerSuggestions.map(s => ({ ...s, providerKey: provider.key })));
                }
            }
            return {
                from: match.from,
                options: allSuggestions.map(s => ({
                    label: s.label,
                    type: s.providerKey,
                    apply: (view, _, from, to) => {
                        view.dispatch({ changes: { from, to, insert: `[${s.label}](${`mdx://${s.providerKey}/${s.id}`}) ` } });
                    }
                })),
                filter: false,
            };
        };
    }
    
    /**
     * [新增] 创建一个 Marked.js 扩展，用于将 mdx:// 链接渲染为带有数据属性的 HTML 字符串。
     * 这个方法是纯粹的，只负责渲染，不处理任何交互。
     */
    _createLinkRendererExtension() {
        return {
            name: 'demoMentionLink',
            renderer: {
                link: (href, _, text) => {
                    if (!href.startsWith('mdx://')) return false;
                    return `<a href="${this._escapeHTML(href)}" data-mdx-uri="${this._escapeHTML(href)}">${this._escapeHTML(text)}</a>`;
                }
            }
        };
    }

    /**
     * [新增] 创建一个 Marked.js 扩展，用于解析和渲染 !@... 内容嵌入语法。
     */
    _createTransclusionExtension() {
    const self = this; // 保存 this 引用
        return {
            name: 'demoMentionTransclusion',
            level: 'block',
            start: (src) => src.match(/^!@\w+:[^\s]+/)?.index,
            tokenizer: (src) => {
                const match = /^!@(\w+):([^\s]+)/.exec(src);
                if (match) {
                    return {
                        type: 'demoMentionTransclusion', // Token 的类型
                        raw: match[0],
                        key: match[1],
                        id: match[2].trim()
                    };
                }
                return undefined;
            },
            // [最终修正] `renderer` 是一个对象，
            // 对象的键必须与上面 tokenizer 返回的 `type` 完全匹配。
        renderer(token) {
            // 注意：这里不是对象，而是直接的函数
            const escapeHTML = (str) => str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
            
            const uri = `mdx://${token.key}/${token.id}`;
            return `<div class="transclusion-block" data-transclusion-uri="${escapeHTML(uri)}">Loading ${token.raw}...</div>`;
        }
    };
    }


    /**
     * [新增] 在渲染容器上附加事件监听器，使用事件委托来处理交互。
     * 这个方法只负责交互，不处理渲染。
     * @param {HTMLElement} element 渲染内容的根元素
     */
    _attachEventListeners(element) {
        if (element.dataset.mentionListenersAttached) return;
        element.dataset.mentionListenersAttached = 'true';
        element.addEventListener('click', e => this._handleClick(e));
        element.addEventListener('mouseover', e => this._handleMouseOver(e));
        element.addEventListener('mouseout', e => this._handleMouseOut(e));
        this._processTransclusions(element);
    }


    /**
     * [新增] 查找并填充内容嵌入的占位符。
     * @param {HTMLElement} element 
     */
    async _processTransclusions(element) {
        const placeholders = element.querySelectorAll('.transclusion-block[data-transclusion-uri]:not([data-transclusion-processed])');
        // [REFACTORED] We no longer need to access any internal property of the editor.
        // The `renderInElement` capability is provided directly by the context.
        if (!this.context || placeholders.length === 0) return;
        
        for (const el of placeholders) {
            if (!(el instanceof HTMLElement)) continue; // FIXED: Type guard
            el.dataset.transclusionProcessed = 'true';
            const uri = new URL(el.dataset.transclusionUri);
            const provider = this.providers.get(uri.hostname);

            if (provider?.getContentForTransclusion) {
                const markdown = await provider.getContentForTransclusion(uri);
                if (markdown !== null) {
                    const tempContainer = document.createElement('div');
                    // [修改] 使用正确的公共 API 来执行递归渲染
                    // `context.coreInstance` 是 MDxEditor 实例，它有一个公共的 .getRenderer() 方法。
                    const renderer = this.context.coreInstance?.getRenderer();
                    if (renderer) {
                        await renderer.render(tempContainer, markdown);
                        el.innerHTML = tempContainer.innerHTML;
                        this._attachEventListeners(el);
                    } else {
                         el.innerHTML = `<div class="transclusion-error">Renderer not available.</div>`;
                    }
                } else {
                    el.innerHTML = `<div class="transclusion-error">Content not found.</div>`;
                }
            }
        }
    }

    _handleClick(e) {
        const link = e.target.closest('a[data-mdx-uri]');
        if (link) {
            e.preventDefault();
            const url = new URL(link.dataset.mdxUri);
            this.providers.get(url.hostname)?.handleClick(url);
        }
    }

    _handleMouseOver(e) {
        const link = e.target.closest('a[data-mdx-uri]');
        if (link) this.debouncedGetHoverPreview(link);
    }
    
    _handleMouseOut(e) {
        const link = e.target.closest('a[data-mdx-uri]');
        if (link && !this.previewCardEl?.matches(':hover')) {
            this.debouncedGetHoverPreview.cancel();
            this.hidePreviewCard();
        }
    }

    async _getHoverPreview(target) {
        const url = new URL(target.dataset.mdxUri);
        const provider = this.providers.get(url.hostname);
        if (provider?.getHoverPreview) {
            const previewData = await provider.getHoverPreview(url);
            if (previewData) {
                // [修改] 适配 getHoverPreview 的返回结构 {title, contentHTML, icon}
                const cardHTML = `
                    <div class="mdx-mention-preview-header">
                        ${previewData.icon || ''}
                        <span class="mdx-mention-preview-title">${this._escapeHTML(previewData.title)}</span>
                    </div>
                    <div class="mdx-mention-preview-content">
                        ${previewData.contentHTML}
                    </div>
                `;
                this.showPreviewCard(target, cardHTML);
            }
        }
    }

    // --- 服务 API 实现 ---
    _handleExternalUpdate({ uri, newLabel }) {
        // [修改] 使用公共 API getEditorView() 访问 CodeMirror 实例
        const editorView = this.context?.coreInstance?.getEditorView();
        if (!editorView) return;
        
        const doc = editorView.state.doc;
        const changes = [];
        const regex = new RegExp(`\\[([^\\]]+)\\]\\(${uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g');
        for (const match of doc.toString().matchAll(regex)) {
            if (match[1] !== newLabel) {
                changes.push({ from: match.index + 1, to: match.index + 1 + match[1].length, insert: newLabel });
            }
        }
        if (changes.length > 0) editorView.dispatch({ changes });
    }

    showPreviewCard(target, htmlContent) {
        if (!this.previewCardEl) {
            this.previewCardEl = document.createElement('div');
            this.previewCardEl.className = 'mdx-mention-preview-card';
            document.body.appendChild(this.previewCardEl);
            this.previewCardEl.addEventListener('mouseleave', () => this.hidePreviewCard());
        }
        this.previewCardEl.innerHTML = htmlContent;
        const rect = target.getBoundingClientRect();
        this.previewCardEl.style.display = 'block';
        this.previewCardEl.style.left = `${window.scrollX + rect.left}px`;
        this.previewCardEl.style.top = `${window.scrollY + rect.bottom + 5}px`;
    }
    
    hidePreviewCard() { if (this.previewCardEl) this.previewCardEl.style.display = 'none'; }
    _escapeHTML = (str) => str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    _debounce = (func, delay) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => func(...a), delay); }; d.cancel = () => clearTimeout(t); return d; };
}

// ======================================================
//   [NEW] Demo-specific Custom Plugin
// ======================================================

/**
 * A custom plugin to demonstrate adding buttons to the title bar.
 * @implements {MDxPlugin}
 */
class CustomTitleBarButtonsPlugin {
    name = 'demo:custom-title-bar-buttons';

    /** @param {PluginContext} context */
    install(context) {
        context.registerCommand('saveDocument', (editor) => {
            alert('"Save" button clicked! Content:\n\n' + editor.getText());
        });

        context.registerTitleBarButton({
            id: 'custom-save',
            title: '保存文档',
            icon: '<i class="fas fa-save"></i>',
            command: 'saveDocument',
            location: 'right'
        });
        
        context.registerTitleBarButton({
            id: 'custom-help',
            title: '帮助',
            icon: '<i class="fas fa-question-circle"></i>',
            location: 'right',
            onClick: () => {
                alert('Help button clicked!');
            }
        });
    }
}


// [修改] 将整个 DOMContentLoaded 回调设为 async，以支持 await createMDxEditor
document.addEventListener('DOMContentLoaded', async () => {

    // ======================================================
    //   场景 1: MDxEditor 集成编辑器
    // ======================================================
    const initialMarkdown = `# Welcome to MDxEditor!

这是一个基于插件的高度可扩展的编辑器和渲染器系统。

## 核心功能

- **无缝切换**: 使用工具栏在“编辑”和“预览”模式之间切换。
- **同步滚动**: 你的滚动位置将在视图之间保持同步。
- **交互式编辑**: 在预览模式下, 按住 **Ctrl/Cmd 并双击** --cloze-- 或任意段落，即可跳回其源码位置。

## 亲自试一试!

选择下面的文本，并使用工具栏按钮应用格式。

1.  这是一个 Cloze 示例: --纽约市--.
2.  这是 **粗体** 和 *斜体*.

::> 这是一个可折叠块
    你可以在编辑视图中编辑其内容。
    - [x] 任务 1
    - [ ] 任务 2
`;

    // [MODIFIED] Create an instance of our new custom plugin
    const customTitleBarPlugin = new CustomTitleBarButtonsPlugin();
    
    // [修改] 使用新的 createMDxEditor 工厂函数进行实例化
    /** @type {MDxEditor} */
    const editor = await createMDxEditor(document.getElementById('app-container'), {
        initialContent: initialMarkdown, // [修改] 配置项从 initialText 改为 initialContent
        plugins: [
            // [修改] 无需传入 defaultPlugins，工厂函数会自动加载默认插件
            // 只需添加额外的自定义插件实例
            customTitleBarPlugin 
        ],
        titleBar: {
            title: "My Document.md",
            enableToggleEditMode: true,
            onSidebarToggle: () => {
                alert("Sidebar toggled! (This is a demo callback)");
            }
        }
    });

    // ======================================================
    //   [NEW] 场景 1: 外部控制和事件监听演示
    // ======================================================
    const externalEditBtn = document.getElementById('external-edit-btn');
    const externalPreviewBtn = document.getElementById('external-preview-btn');
    const modeDisplay = document.getElementById('current-mode-display');

    const isButton = (el) => el instanceof HTMLButtonElement;

    if (externalEditBtn) {
        externalEditBtn.addEventListener('click', () => editor.switchToMode('edit')); // [修改] API 名称统一为 switchToMode
    }
    if (externalPreviewBtn) {
        externalPreviewBtn.addEventListener('click', () => editor.switchToMode('render')); // [修改] API 名称统一为 switchToMode
    }

    editor.on('modeChanged', ({ mode }) => {
        if (modeDisplay instanceof HTMLElement) modeDisplay.textContent = `当前模式: ${mode}`;
        if (isButton(externalEditBtn)) externalEditBtn.disabled = (mode === 'edit');
        if (isButton(externalPreviewBtn)) externalPreviewBtn.disabled = (mode === 'render');
    });

    const initialMode = editor.getMode();
    if (modeDisplay instanceof HTMLElement) modeDisplay.textContent = `当前模式: ${initialMode}`;
    if (isButton(externalEditBtn)) externalEditBtn.disabled = (initialMode === 'edit');
    if (isButton(externalPreviewBtn)) externalPreviewBtn.disabled = (initialMode === 'render');

    // ======================================================
    //   [NEW] 场景 2: Mention System Editor
    const mentionInitialText = `# Team Collaboration Document

This document tracks our progress. The main reference is @Project Proposal.

It was reviewed by @Alice.

## Embedded Content
Here is the content of the meeting notes:
!@file:doc-2

Let's check the technical specs too: @Technical Spec
`;

    const mentionPlugin = new DemoMentionPlugin({ providers: [new FileMentionProvider(), new UserMentionProvider()] });

    // [修改] 同样使用 createMDxEditor 工厂函数进行实例化
    /** @type {MDxEditor} */
    const mentionEditor = await createMDxEditor(document.getElementById('mention-editor-container'), {
        initialContent: mentionInitialText, // [修改] 配置项名称变更
        plugins: [mentionPlugin], // [修改] 只需传入自定义插件
        titleBar: {
            title: "Collaboration Space",
            enableToggleEditMode: true,
        }
    });

    document.getElementById('rename-doc1-btn').addEventListener('click', () => {
        const newTitle = 'Final Proposal';
        mockDatabase.files.get('doc-1').title = newTitle;
        alert(`"Project Proposal" 已重命名为 "${newTitle}". 编辑器将同步更新.`);
        
        // [修改] 改为执行命令，而不是调用 getService
        const payload = { uri: 'mdx://file/doc-1', newLabel: `📄 ${newTitle}` };
        if (mentionEditor.commands.updateMentionLabel) {
            mentionEditor.commands.updateMentionLabel(payload);
        }
    });


    // ======================================================
    //   场景 3: Anki 静态渲染 (Advanced)
    // ======================================================
    const ankiInput = document.getElementById('anki-input');
    if (ankiInput instanceof HTMLTextAreaElement) {
        ankiInput.value = `# 美国历史测验
## 第一任总统是谁？
- [ ] 亚伯拉罕·林肯
- [x] **乔治·华盛顿**

美国的第一个首都是--纽约市--。它叫做--New York--^^audio: New York^^。

::> 更多关于华盛顿的信息
    他是一位来自弗吉尼亚州的--种植园主--。
    这是--一个¶多行--的cloze。
    \`\`\`mermaid
    graph TD
        A[历史事件] -->|导致| B(独立战争);
    \`\`\`
    数学公式: $$E=mc^2$$
`;
    }
    const clozeStates = {
            [`anki-demo_${simpleHash('纽约市')}`]: { isHidden: true, memoryTier: 'due' },
            [`anki-demo_${simpleHash('New York')}`]: { isHidden: true, memoryTier: 'learning-7d' },
            [`anki-demo_${simpleHash('种植园主')}`]: { isHidden: true, memoryTier: 'mature' },
            [`anki-demo_${simpleHash('一个\n多行')}`]: { isHidden: true, memoryTier: 'new' },
        };
    
    // [修改] 独立渲染器的插件注册方式变更
    // 1. 创建一个包含所需插件实例的数组
    const defaultRendererPlugins = [
        new FoldablePlugin(),
        new MathJaxPlugin(),
        new MediaPlugin(),
        new MermaidPlugin(),
        new TaskListPlugin(),
        new ClozePlugin()
    ];
    
    // 2. 实例化渲染器
    const ankiRenderer = new MDxRenderer();
    
    // 3. 使用 .usePlugin() 方法注册所有插件
    [...defaultRendererPlugins, new AnkiFeedbackPlugin()].forEach(p => ankiRenderer.usePlugin(p));

    const renderAnki = () => {
        if (ankiInput instanceof HTMLTextAreaElement) {
            ankiRenderer.render(document.getElementById('anki-output'), ankiInput.value, { 
                contextId: 'anki-demo',
                clozeStates: JSON.parse(JSON.stringify(clozeStates)),
                on: { taskToggled: d => alert(`任务 "${d.taskText}" 状态: ${d.isChecked ? '完成' : '未完成'}.`) }
            });
        }
    };
    document.getElementById('render-anki').addEventListener('click', renderAnki);
    renderAnki();

    // ======================================================
    //   场景 4: Agent 流式渲染
    // ======================================================
    // Note: The streaming API itself is not plugin-based in this refactor,
    // but the final render pass could benefit from plugins.
    // For this demo, we'll keep it simple and create a dedicated renderer.
    const agentOutput = document.getElementById('agent-output');
    const streamBtn = document.getElementById('render-stream');
    
    // [修改] 流式渲染器同样采用新的插件注册方式
    const chatRenderer = new MDxRenderer();
    defaultRendererPlugins.forEach(p => chatRenderer.usePlugin(p)); // 复用上面定义的默认渲染插件

    streamBtn.addEventListener('click', () => {
        // @ts-ignore
        streamBtn.disabled = true;
        streamBtn.textContent = '流式渲染中...';
        agentOutput.innerHTML = '';

        const textChunks = [
            "你好！让我为你演示**流式渲染**的全部功能。\n\n",
            "## 核心概念\n",
            "首先，支持 **Cloze 填空**。例如，水的化学式是 --H₂O--。\n",
            "其次，是 GFM **任务列表**：\n",
            "- [x] 设计 Demo 内容\n- [ ] 实现交互性\n\n",
            "**数学公式**也不在话下：$$E = mc^2$$\n\n",
            "最后，还能渲染 **Mermaid 图表** 和 **媒体链接**：\n",
            "```mermaid\ngraph LR\n    A[开始] --> B{完成?};\n    B -->|是| C[结束];\n```\n",
            "视频演示: !video[Demo Video](https://www.w3schools.com/html/mov_bbb.mp4)\n",
            "附件: !file[说明文档.pdf](#)"
        ];

        let fullText = "";
        let i = 0;
        const intervalId = setInterval(() => {
            if (i < textChunks.length) {
                fullText += textChunks[i];
                // In a true streaming scenario, you might re-render on each chunk.
                // Here we simulate by rendering the accumulating text.
                chatRenderer.render(agentOutput, fullText + '<span class="streaming-cursor"></span>');
                i++;
            } else {
                clearInterval(intervalId);
                // Final render to process everything (e.g., Mermaid, MathJax)
                chatRenderer.render(agentOutput, fullText).then(() => {
                    // @ts-ignore
                    streamBtn.disabled = false;
                    streamBtn.textContent = "重新开始流式渲染";
                });
            }
        }, 200);
    });

    // ======================================================
    //   [新增] 场景 5: MDxProcessor 无头处理演示
    // ======================================================
    const processorInputEl = document.getElementById('processor-input');
    const processorOptionsEl = document.getElementById('processor-options');
    const processorOutputEl = document.getElementById('processor-output');
    const processBtn = document.getElementById('process-btn');

    if (processorInputEl instanceof HTMLTextAreaElement) {
        processorInputEl.value = `---
    title: Weekly Report
    author: @user:alice
    ---
    
    This week, we focused on the tasks outlined in @file:doc-1.
    
    A key resource was the technical specification: @file:doc-3.
    `;
    }

    const defaultProcessOptions = {
        rules: {
            'user': { action: 'extract', collectMetadata: true, },
            'file': {
                action: 'replace',
                collectMetadata: true,
                getReplacementContent: (data, mention) => {
                    if (!data) return `[File Not Found: ${mention.id}]`;
                    return `> **${data.title}**\n> \n> ${data.content.split('\n')[0]}`;
                }
            },
            '*': { action: 'keep', collectMetadata: false, }
        }
    };
    if (processorOptionsEl instanceof HTMLTextAreaElement) {
        processorOptionsEl.value = JSON.stringify(defaultProcessOptions, null, 2);
    }
    const processor = new MDxProcessor([new FileMentionProvider(), new UserMentionProvider()]);
    
    // 4. 为按钮添加点击事件
    processBtn.addEventListener('click', async () => {
        if (!(processorInputEl instanceof HTMLTextAreaElement) || 
            !(processorOptionsEl instanceof HTMLTextAreaElement)) {
            return;
        }
    
        const markdownInput = processorInputEl.value;
        let options;
        try {
            options = JSON.parse(processorOptionsEl.value);
            if (processorOutputEl instanceof HTMLElement) processorOutputEl.textContent = 'Processing...';
            if (processBtn instanceof HTMLButtonElement) processBtn.disabled = true;

            const result = await processor.process(markdownInput, options);
        
            if (processorOutputEl instanceof HTMLElement) processorOutputEl.textContent = JSON.stringify(result, null, 2);
        } catch (error) {
            if (processorOutputEl instanceof HTMLElement) {
                processorOutputEl.textContent = `Error processing:\n\n${error.message}\n\nCheck your JSON options format.`;
            }
            console.error(error);
        } finally {
            if (processBtn instanceof HTMLButtonElement) processBtn.disabled = false;
        }
    });

    // ======================================================
    //   [NEW] 场景 0: 全局搜索逻辑
    // ======================================================
    const searchInput = document.getElementById('global-search-input');
    const prevBtn = document.getElementById('search-prev-btn');
    const nextBtn = document.getElementById('search-next-btn');
    const countEl = document.getElementById('search-results-count');

    // 定义所有可被搜索的实例
    const searchableInstances = [
        { instance: editor, name: '集成编辑器' },
        { instance: mentionEditor, name: 'Mention编辑器' },
        { instance: ankiRenderer, name: 'Anki渲染区' }
    ];

    let allMatches = [];
    let currentIndex = -1;

    // [修正] 将 performSearch 声明为 async 函数，以处理异步的 search API
    const performSearch = async () => {
    if (!(searchInput instanceof HTMLInputElement)) return;
        const query = searchInput.value;
        allMatches = [];
        currentIndex = -1;

        if (!query) {
            // 清空所有实例的搜索状态
            searchableInstances.forEach(({ instance }) => instance.clearSearch());
            updateUI();
            return;
        }

        // [修正] 使用 for...of 循环代替 forEach，以便在循环体内安全地使用 await
        // 因为 forEach 的回调函数是同步执行的，它不会等待内部的 await 完成。
        for (const { instance } of searchableInstances) {
            // 关键：调用统一的search API
            // [修正] 使用 await 等待 instance.search(query) 的 Promise 解析完成。
            // `MDxEditor.search` 是一个 async 函数，所以它返回的是一个 Promise，而不是一个数组。
            // 直接对 Promise 调用 .forEach() 会导致 "is not a function" 错误。
            const matches = await instance.search(query);

            // 增加一个健壮性检查，确保 `matches` 确实是一个数组
            if (Array.isArray(matches)) {
                matches.forEach(match => {
                    // 将每个匹配项与其实例关联起来，存入全局列表
                    allMatches.push({ instance, match });
                });
            }
        }

        updateUI();
    };

    const updateUI = () => {
        const total = allMatches.length;
        if (countEl instanceof HTMLElement) {
            if (total > 0) {
                countEl.textContent = `找到 ${currentIndex + 1} / ${total} 个结果`;
            } else {
                countEl.textContent = searchInput instanceof HTMLInputElement && searchInput.value ? '未找到结果' : '';
            }
        }
        if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = total === 0;
        if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = total === 0;
    };
    
    const navigateToMatch = (index) => {
        if (index < 0 || index >= allMatches.length) return;

        const { instance, match } = allMatches[index];
        // 关键：调用统一的gotoMatch API
        instance.gotoMatch(match);
        currentIndex = index;
        updateUI();
    };

    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    }

    searchInput.addEventListener('input', debounce(performSearch, 300));

    nextBtn.addEventListener('click', () => {
        if (allMatches.length === 0) return;
        navigateToMatch((currentIndex + 1) % allMatches.length);
    });

    prevBtn.addEventListener('click', () => {
        if (allMatches.length === 0) return;
        navigateToMatch((currentIndex - 1 + allMatches.length) % allMatches.length);
    });

    // ======================================================
    //   全局交互处理器 (事件委托)
    // ======================================================
    const audioPlayer = {
        play(text) {
            if (!text || !('speechSynthesis' in window)) return;
            console.log(`[AudioPlayer] 朗读: "${text}"`);
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'en-US';
            window.speechSynthesis.speak(utterance);
        }
    };

    document.body.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    
    // --- 音频播放逻辑 ---
    const mediaIcon = target.closest('.media-icon');
    if (mediaIcon instanceof HTMLElement && mediaIcon.dataset.audioText) {
            event.stopPropagation(); // 防止触发 Cloze 点击
            audioPlayer.play(mediaIcon.dataset.audioText);
            return;
        }

        // --- 流式渲染中的 Cloze 简单切换 (由 ClozePlugin 自动处理) ---
        // The event listener inside the ClozePlugin now handles this automatically
        // for any element it's rendered into.
        // We only need this if we want custom behavior.
    });
});

/*
import { getVFSManager,VFSPersistenceAdapter } from '@itookit/vfs';
import { MemoryPluginV2 } from './plugins/MemoryPlugin.v2.js';

async function initEditor() {
    // 初始化 VFS
    const vfs = getVFSManager();
    await vfs.init();
    
    // 创建或获取文档节点
    const note = await vfs.createFile(
        'notes',
        '/my-note.md',
        '# My Note\n{{c1::Important concept}}'
    );
    
    // 创建 VFS 适配器
    const adapter = new VFSPersistenceAdapter(vfs, note.id);
    
    // 创建编辑器实例
    const editor = new MDxEditor({
        target: document.getElementById('editor'),
        dataAdapter: adapter,
        vfsCore: vfs,        // 注入 VFSCore
        currentNodeId: note.id  // 注入当前节点ID
    });
    
    // 注册插件
    editor.use(new MemoryPluginV2());
    
    // 加载内容
    const { content } = await vfs.read(note.id);
    await editor.setMarkdown(content);
}

示例 A：使用 VFSCore（推荐）

import { getVFSManager } from '@itookit/vfs';
import { MDxEditor } from '@itookit/mdxeditor';
import { MemoryPluginV2 } from './plugins/MemoryPlugin.v2.js';

async function createEditor() {
    const vfs = getVFSManager();
    await vfs.init();
    
    const note = await vfs.createFile(
        'notes',
        '/my-note.md',
        '# My Note\n{{c1::Test}}'
    );
    
    const editor = new MDxEditor(document.getElementById('editor'), {
        vfsCore: vfs,
        nodeId: note.id,
        plugins: [
            new MemoryPluginV2()
        ]
    });
    
    const { content } = await vfs.read(note.id);
    editor.setText(content);
}

示例 B：使用传统 dataAdapter（向后兼容）

import { MDxEditor } from '@itookit/mdxeditor';
import { LocalStorageAdapter } from './adapters/LocalStorageAdapter.js';
import { MemoryPlugin } from './plugins/MemoryPlugin.js'; // 旧版本

const editor = new MDxEditor(document.getElementById('editor'), {
    dataAdapter: new LocalStorageAdapter(),
    plugins: [
        new MemoryPlugin() // 使用旧的插件
    ]
});

示例 C：无持久化（开发/测试）
const editor = new MDxEditor(document.getElementById('editor'), {
    // 不提供任何持久化选项
    // 数据仅在内存中
});
*/