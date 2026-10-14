// demo/memory-manager.js
// --- 模拟导入 (在真实项目中，这些通过 import { ... } from '@itookit/...' 引入) ---
// 假设浏览器环境配置了 import map 或者使用 Vite

// --- 模拟导入 ---
import { createVFSCore, VFSEventType } from '@itookit/vfs'; // [修正] 导入工厂函数
import { Workbench } from '@itookit/app-shell';
import { createMDxEditor } from '@itookit/mdxeditor';

// --- 辅助工具：标准配置生成器 (模拟库提供的 Helper) ---
// 这个 Helper 极大简化了用户的配置负担
const createStandardConfig = (options, customConfig = {}) => {
    const basePlugins = [
        'core:titlebar', 'ui:toolbar', 'ui:formatting', 
        'mathjax', 'media', 'mermaid', 'folder', 
        'task-list', 'codeblock-controls', 'interaction:source-sync',
        'autocomplete:tag', 'autocomplete:mention'
    ];
    const finalPlugins = [...basePlugins, ...(customConfig.plugins || [])];

    return {
        // 展开 Workbench 传入的所有上下文 (initialContent, nodeId, callbacks)
        ...options,
        initialMode: 'render',
        plugins: finalPlugins,
        defaultPluginOptions: {
            ...options.defaultPluginOptions,
            'core:titlebar': {
                ...(options.defaultPluginOptions?.['core:titlebar'] || {}),
                title: options.title,
                enableToggleEditMode: true,
                ...(customConfig.titleBar || {})
            },
            'task-list': { autoUpdateMarkdown: true, ...(customConfig.taskList || {}) }
        }
    };
};

const updateStatus = (msg) => {
    const el = document.getElementById('status-indicator');
    if (el) el.textContent = msg;
    console.log(`[Status] ${msg}`);
};

// --- 1. 数据准备 ---
async function prepareMockData(vfsCore) {
    updateStatus('Preparing VFS data...');
    const moduleName = 'demo-notes';
    
    // Workbench.start() 会自动处理 mount，这里主要是创建文件
    const safeCreate = async (path, content, tags = []) => {
        try { 
            const file = await vfsCore.createFile(moduleName, path, content); 
            for (const tag of tags) {
                await vfsCore.addTag(moduleName, path, tag);
            }
        } catch (e) { /* ignore exists */ }
    };

    await safeCreate('/Welcome.md', 
`# 👋 Welcome to Memory Manager

This is a demo of the **Memory Manager** library.

It connects:
- **VFS-UI**: The file tree on the left.
- **MDxEditor**: This editor you are typing in.
- **VFS-Core**: The virtual file system storing this data.

## Features to try:
1. [ ] Click the sidebar toggle button in the top-left of this editor.
2. [ ] Create a new file in the sidebar.
3. [ ] Add a tag using \`#\` symbol.
4. [ ] Switch files and notice how your changes are auto-saved.
`);

    await safeCreate('/Tasks.md', 
        `# 📝 My Tasks

- [x] Initialize VFS
- [ ] Implement EditorFactory
- [ ] Test Sidebar Toggle
- [ ] Write Documentation
`);

    await safeCreate('/Ideas/Project X.md',
        `# 🚀 Project X Ideas

> "The best way to predict the future is to create it."

## Brainstorming
- AI integration
- Real-time collaboration
`);

    updateStatus('Data ready.');
}

// --- 2. 极简 Editor Factory ---
const simpleEditorFactory = async (container, options) => {
    // 使用 Helper，用户只需配置差异
    const config = createStandardConfig(options, {
        // 例如：自定义 task-list 选择器
        taskList: { checkboxSelector: '.todo-checkbox' }
    });
    return createMDxEditor(container, config);
};

// --- 3. 启动 ---
async function bootstrap() {
    try {
        // 初始化 Core
        const vfsCore = await createVFSCore('memory-manager-demo');
        await prepareMockData(vfsCore);

        const container = document.getElementById('memory-manager-root');
        container.innerHTML = '';

        // Create layout DOM (previously in memory-manager's Layout.ts)
        const layoutEl = document.createElement('div');
        layoutEl.className = 'mm-layout';

        const sidebarEl = document.createElement('div');
        sidebarEl.className = 'mm-sidebar';

        const editorEl = document.createElement('div');
        editorEl.className = 'mm-editor-area';

        layoutEl.appendChild(sidebarEl);
        layoutEl.appendChild(editorEl);
        container.appendChild(layoutEl);

        // 初始化 Manager
        const manager = new Workbench({
            sidebarContainer: sidebarEl,
            editorContainer: editorEl,
            vfsCore,
            moduleName: 'demo-notes',
            editorFactory: simpleEditorFactory,
            aiConfig: { enabled: true },
            uiOptions: {
                title: 'Second Brain',
                searchPlaceholder: 'Search (e.g. tag:work)...'
            },
            onSidebarToggle: (collapsed) => {
                if (collapsed) {
                    sidebarEl.classList.add('is-collapsed');
                } else {
                    sidebarEl.classList.remove('is-collapsed');
                }
                setTimeout(() => window.dispatchEvent(new Event('resize')), 310);
            },
        });

        // 启动 (Workbench 会自动打开第一个文件)
        await manager.start();
        updateStatus('System Ready.');

        // 监听事件
        vfsCore.getEventBus().on(VFSEventType.NODE_UPDATED, (evt) => {
             if (evt.data?.source === 'AI_BRAIN') {
                 updateStatus(`🤖 AI analyzed node ${evt.nodeId}`);
             }
        });

    } catch (error) {
        console.error(error);
        updateStatus('Error: ' + error.message);
    }
}

// 运行
bootstrap();