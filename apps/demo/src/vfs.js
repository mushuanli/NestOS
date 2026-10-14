/**
 * @file @mdx/demo/vfs.js
 * @description MDxEditor + VFS-UI 完整功能演示脚本
 */

// --- 类型定义，用于 JSDoc 和智能提示 ---
/** 
 * @typedef {import('@itookit/common').IEditor} IEditor
 * @typedef {import('@itookit/common').EditorOptions} EditorOptions
 * @typedef {import('@itookit/common').ISessionUI} ISessionUI
 * @typedef {import('@itookit/vfs-ui').VFSNodeUI} VFSNodeUI 
 * @typedef {import('@itookit/vfs-ui').VFSService} VFSService
 * @typedef {import('@itookit/vfs').VFSCore} VFSCore
 */

// --- 导入 VFS-UI 库 ---
// [修正] createVFSUI 应该从 vfs-ui 导入，而不是 memory-manager
import { connectEditorLifecycle, createVFSUI } from '@itookit/vfs-ui';
import '@itookit/vfs-ui/style.css';

// --- 导入 MDxEditor 及其插件 ---
// ✨ [最终] 应用层是唯一需要知道具体编辑器实现的地方
import { createMDxEditor } from '@itookit/mdxeditor';
import '@itookit/mdxeditor/style.css';

// --- 导入 vfs 的便利函数 ---
import { createVFSCore,VFSModuleEngine } from '@itookit/vfs';

//-----------------------------------------------------------------

/** @type {IEditor | null} */
let currentEditorInstance = null; // 用于响应 UI 事件，如大纲导航

/**
 * 设置与编辑器生命周期无关的应用级别 UI 交互。
 * @param {ISessionUI<VFSNodeUI, VFSService>} vfsUIManager 
 * @param {VFSCore} vfsCore 
 */
function setupAppUIHandlers(vfsUIManager, vfsCore) {
    const appContainer = document.getElementById('app-container');

    // 监听侧边栏折叠状态变化
    vfsUIManager.on('sidebarStateChanged', ({ isCollapsed }) => {
        appContainer.classList.toggle('sidebar-collapsed', isCollapsed);
    });

    // 监听大纲导航请求
    vfsUIManager.on('navigateToHeading', ({ elementId }) => {
        if (!currentEditorInstance) return;

        // MDxEditor 特有的逻辑：确保在渲染模式下导航
        if (typeof currentEditorInstance.switchToMode === 'function') {
            // @ts-ignore
            currentEditorInstance.switchToMode('render');
        }

        setTimeout(() => {
            currentEditorInstance.navigateTo({ elementId });

            // 添加视觉高亮效果 (可选)
            const editorContainer = document.getElementById('editor-container');
            // 注意：MDxEditor 的渲染容器类名通常包含 mdx-editor-renderer
            const renderEl = editorContainer?.querySelector('.mdx-editor-renderer') || editorContainer?.querySelector('.mdx-render-view');
            const targetEl = renderEl?.querySelector(`#${elementId}`);

            if (targetEl instanceof HTMLElement) {
                targetEl.style.transition = 'none';
                targetEl.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
                setTimeout(() => {
                    targetEl.style.transition = 'background-color 0.5s ease';
                    targetEl.style.backgroundColor = 'transparent';
                }, 1000);
            }
        }, 50); // 短暂延迟确保视图切换完成
    });

    // 监听文件导入请求
    vfsUIManager.on('importRequested', ({ parentPath }) => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.md,.txt';
        fileInput.multiple = true;
        fileInput.style.display = 'none';

        fileInput.onchange = () => {
            if (!fileInput.files) return;
            Array.from(fileInput.files).forEach(file => {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    if (e.target?.result && typeof e.target.result === 'string') {
                        const content = e.target.result;
                        const title = file.name.replace(/\.(md|txt)$/, '');

                        // [修正] VFSService 中没有 createSession，方法名是 createFile
                        await vfsUIManager.sessionService.createFile({
                            title,
                            content,
                            parentPath
                        });
                    }
                };
                reader.readAsText(file);
            });
            document.body.removeChild(fileInput);
        };

        document.body.appendChild(fileInput);
        fileInput.click();
    });

    // 监听自定义菜单项点击
    vfsUIManager.on('menuItemClicked', async ({ actionId, item }) => {
        switch (actionId) {
            case 'export-as-markdown':
                if (item.type === 'file') {
                    const content = await vfsCore.getVFS().read(item.id);
                    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${item.metadata.title.replace(/[^\w\s.-]/g, '') || 'untitled'}.md`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }
                break;
            case 'copy-id':
                navigator.clipboard.writeText(item.id)
                    .then(() => alert(`ID "${item.id}" 已复制。`))
                    .catch(err => console.error('复制失败:', err));
                break;
            case 'share-file':
                alert(`正在分享文件: "${item.metadata.title}" (自定义操作)`);
                break;
            default:
                console.warn(`未处理的自定义菜单动作: "${actionId}"`);
        }
    });
}


/**
 * 应用主入口函数
 */
async function main() {
    const moduleName = 'notes';
    
    // --- 步骤 1: 初始化 vfs ---
    const vfsCore = await createVFSCore({
        dbName: 'VFS_Demo_MindOS_Connector',
        defaultModule: moduleName
    });
    console.log('vfs initialized and "notes" module is ready.');

    // 初始化引擎适配器 (ISessionEngine 实现)
    const engine = new VFSModuleEngine(moduleName);
    
    // --- 步骤 2: 初始化 VFS-UI ---
    // [修正] createVFSUI 签名: (options, engine)
    const vfsUIManager = createVFSUI({
        sessionListContainer: document.getElementById('sidebar-container'),
        title: "我的笔记",
        // [新增] 默认文件配置，防止空状态
        defaultFileName: "Welcome.md",
        defaultFileContent: "# Welcome\n\nStart writing your notes here.",
        contextMenu: {
            items: (item, defaultItems) => [
                ...defaultItems,
                { type: 'separator' },
                { id: 'share-file', label: '分享...', iconHTML: '<i class="fas fa-share-alt"></i>', hidden: (it) => it.type !== 'file' },
                { id: 'export-as-markdown', label: '导出为 Markdown', iconHTML: '<i class="fas fa-file-export"></i>', hidden: (it) => it.type !== 'file' },
                { id: 'copy-id', label: '复制节点ID', iconHTML: '<i class="fas fa-fingerprint"></i>' }
            ]
        }
    }, engine);

    /**
     * ✨ 适配器工厂
     * 将通用的 EditorOptions 转换为 MDxEditor 配置
     * @param {HTMLElement} container
     * @param {EditorOptions} options
     * @returns {Promise<IEditor>}
     */
    const mdxEditorFactoryAdapter = (container, options) => {
        console.log(`[vfs.js Factory] Creating editor for node: ${options.nodeId}`);
        
        const mdxConfig = {
            ...options,
            // 注入 vfsCore 供编辑器内部插件 (如图片上传/引用) 使用
            vfsCore: vfsCore, 
            initialMode: 'render', // 默认阅读模式
            plugins: [
                'editor:core', // 显式包含核心插件通常更安全，虽有默认值
                'core:titlebar',
                'ui:toolbar',
                'ui:formatting',
                'mathjax',
                'folder',
                'media',
                'mermaid',
                'task-list',
                'codeblock-controls',
                'interaction:source-sync',
                'autocomplete:mention' // 启用提及功能
            ],
            defaultPluginOptions: {
                'core:titlebar': {
                    title: options.title, 
                    onSidebarToggle: () => vfsUIManager.toggleSidebar(),
                    enableToggleEditMode: true
                }
            }
        };
        
        return createMDxEditor(container, mdxConfig);
    };

    // --- 步骤 4: 使用连接器将 VFS-UI 和编辑器连接起来 ---
    connectEditorLifecycle(
        vfsUIManager,
        engine, // [修正] 这里必须传 engine (ISessionEngine)，而不是 vfsCore，因为连接器需要 writeContent 接口
        document.getElementById('editor-container'),
        mdxEditorFactoryAdapter,
        {
            // [可选] 保存防抖时间
            saveDebounceMs: 800,
            // 回调追踪实例
            onEditorCreated: (editor) => {
                currentEditorInstance = editor;
            }
        }
    );
    
    // --- 步骤 5: 设置应用 UI 交互 ---
    setupAppUIHandlers(vfsUIManager, vfsCore);

    // --- 步骤 6: 启动 VFS-UI ---
    // 连接器会自动处理初始文件的加载和编辑器的创建
    await vfsUIManager.start();
}

// 启动应用
document.addEventListener('DOMContentLoaded', main);
