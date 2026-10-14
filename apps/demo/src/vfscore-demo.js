// vfs-demo.js - VFSCore 使用示例

import { getVFSManager } from '@itookit/vfs';

/**
 * 主演示函数
 */
async function runDemo() {
    console.log('=== VFSCore Demo 开始 ===\n');

    // 1. 初始化 VFSCore
    const vfs = getVFSManager();
    await vfs.init({
        defaults: {
            modules: ['notes', 'tasks', 'agents']
        }
    });
    console.log('✓ VFSCore 初始化完成\n');

    // 2. 基本文件操作
    await demoFileOperations(vfs);

    // 3. 目录操作
    await demoDirectoryOperations(vfs);

    // 4. SRS 卡片操作
    await demoSRSOperations(vfs);

    // 5. 任务管理
    await demoTaskOperations(vfs);

    // 6. AI Agent 操作
    await demoAgentOperations(vfs);

    // 7. 链接管理
    await demoLinkOperations(vfs);

    // 8. 搜索功能
    await demoSearchOperations(vfs);

    // 9. 模块管理
    await demoModuleOperations(vfs);

    // 10. 事件监听
    await demoEventOperations(vfs);

    // 11. 统计信息
    await demoStatistics(vfs);

    // 12. 导入导出
    await demoBackupOperations(vfs);

    // 13. 自定义 Provider
    await demoCustomProvider(vfs);

    // 14. 错误处理
    await demoErrorHandling(vfs);

    // 清理
    await vfs.shutdown();
    console.log('\n=== VFSCore Demo 完成 ===');
}

/**
 * 演示基本文件操作
 */
async function demoFileOperations(vfs) {
    console.log('--- 1. 基本文件操作 ---');

    // 创建文件
    const note = await vfs.createFile(
        'notes',
        '/getting-started.md',
        `# Getting Started

## Welcome to VFS
这是一个强大的虚拟文件系统。

## SRS Cards
{{c1::什么是 VFS？}} ^clz-001
{{c1::虚拟文件系统}} ^clz-002

## Tasks
- [ ] @alice [2024-12-31] 阅读文档 ^task-001
- [x] @bob 完成示例 ^task-002

## Links
参考: [[other-note]]
`,
        { contentType: 'markdown' }
    );
    console.log('✓ 创建文件:', note.id);

    // 读取文件
    const { content, metadata } = await vfs.read(note.id);
    console.log('文件内容长度:', content.length);
    console.log('元数据:');
    console.log('  - SRS 卡片数:', metadata.clozes?.length || 0);
    console.log('  - 任务数:', metadata.tasks?.length || 0);
    console.log('  - 链接数:', metadata.outgoingLinks?.length || 0);

    // 更新文件
    await vfs.write(note.id, content + '\n\n## 新增章节\n{{c1::新概念}} ^clz-003');
    console.log('✓ 文件已更新');

    // 获取文件统计
    const stat = await vfs.stat(note.id);
    console.log('文件统计:');
    console.log('  - 大小:', stat.size, 'bytes');
    console.log('  - 修改时间:', stat.modifiedAt);
    console.log('  - Providers:', Object.keys(stat.providers).join(', '));
    console.log('');
}

/**
 * 演示目录操作
 */
async function demoDirectoryOperations(vfs) {
    console.log('--- 2. 目录操作 ---');

    // 创建目录结构
    await vfs.createDirectory('notes', '/projects');
    await vfs.createDirectory('notes', '/archive');
    console.log('✓ 创建目录');

    // 在目录中创建文件
    const file1 = await vfs.createFile('notes', '/projects/project1.md', '# 项目1');
    const file2 = await vfs.createFile('notes', '/projects/project2.md', '# 项目2');
    console.log('✓ 在目录中创建文件');

    // 列出目录内容
    const moduleInfo = vfs.getModule('notes');
    const children = await vfs.readdir(moduleInfo.rootId);
    console.log('根目录内容:');
    children.forEach(child => {
        console.log(`  - ${child.type === 'directory' ? '📁' : '📄'} ${child.name}`);
    });

    // 获取完整文件树
    const tree = await vfs.getTree('notes');
    console.log(`文件树节点总数: ${tree.length}`);

    // 移动文件
    await vfs.move(file1.id, '/archive/project1.md');
    console.log('✓ 文件已移动');

    // 复制文件
    const copiedFile = await vfs.copy(file2.id, '/archive/project2-copy.md');
    console.log('✓ 文件已复制:', copiedFile.id);
    console.log('');
}

/**
 * 演示 SRS 卡片操作
 */
async function demoSRSOperations(vfs) {
    console.log('--- 3. SRS 卡片操作 ---');

    // 创建包含 SRS 卡片的文件
    const srsNote = await vfs.createFile(
        'notes',
        '/srs-cards.md',
        `# SRS 学习卡片

## 基础知识
{{c1::VFS 是什么？}} ^clz-srs-001
{{c1::Virtual File System 的缩写}} ^clz-srs-002

## 高级概念
{{c1::Provider 模式的作用}} ^clz-srs-003
{{c1::处理不同类型的内容}} ^clz-srs-004
`
    );

    // 读取并查看 SRS 元数据
    const { metadata } = await vfs.read(srsNote.id);
    console.log('SRS 卡片信息:');
    console.log('  - 总卡片数:', metadata.totalCards);
    console.log('  - 新卡片:', metadata.newCards);
    console.log('  - 待复习:', metadata.dueCards);

    if (metadata.clozes && metadata.clozes.length > 0) {
        console.log('\n卡片详情:');
        metadata.clozes.slice(0, 2).forEach(card => {
            console.log(`  - ${card.id}: ${card.content.substring(0, 30)}...`);
            console.log(`    状态: ${card.status}, 间隔: ${card.interval} 天`);
        });
    }
    console.log('');
}

/**
 * 演示任务管理
 */
async function demoTaskOperations(vfs) {
    console.log('--- 4. 任务管理 ---');

    // 创建任务文件
    const taskNote = await vfs.createFile(
        'tasks',
        '/team-tasks.md',
        `# 团队任务

## 开发任务
- [ ] @alice [2024-12-25] 实现用户认证 ^task-dev-001
- [ ] @bob [2024-12-26] 编写单元测试 ^task-dev-002
- [x] @charlie [2024-12-20] 代码审查 ^task-dev-003

## 文档任务
- [ ] @alice [2024-12-28] 更新 API 文档 ^task-doc-001
- [ ] 🔴 @bob [2024-12-24] 紧急：修复文档错误 ^task-doc-002
`
    );

    // 读取任务元数据
    const { metadata } = await vfs.read(taskNote.id);
    console.log('任务统计:');
    console.log('  - 总任务数:', metadata.totalTasks);
    console.log('  - 已完成:', metadata.completedTasks);
    console.log('  - 待处理:', metadata.pendingTasks);
    console.log('  - 过期任务:', metadata.overdueTasks);

    if (metadata.tasks && metadata.tasks.length > 0) {
        console.log('\n任务详情:');
        metadata.tasks.slice(0, 3).forEach(task => {
            const status = task.completed ? '✓' : '○';
            const priority = task.priority === 'high' ? '🔴' : '';
            console.log(`  ${status} ${priority} ${task.assignee || '未分配'}: ${task.content}`);
        });
    }
    console.log('');
}

/**
 * 演示 AI Agent 操作
 */
async function demoAgentOperations(vfs) {
    console.log('--- 5. AI Agent 操作 ---');

    // 创建包含 Agent 的文件
    const agentNote = await vfs.createFile(
        'agents',
        '/my-agents.md',
        `# AI Agents

## 写作助手
\`\`\`agent:writer ^agent-writer-001
prompt: 帮我写一篇技术博客
style: 技术性、专业
tone: 友好、易懂
\`\`\`

## 代码审查
\`\`\`agent:coder ^agent-coder-001
task: 审查 Python 代码
focus: 性能、可读性
\`\`\`

## 数据分析
\`\`\`agent:analyzer ^agent-analyzer-001
data_type: CSV
analysis: 统计分析、趋势预测
\`\`\`
`
    );

    // 读取 Agent 元数据
    const { metadata } = await vfs.read(agentNote.id);
    console.log('Agent 统计:');
    console.log('  - 总 Agent 数:', metadata.totalAgents);
    console.log('  - 活跃 Agent:', metadata.activeAgents);

    if (metadata.agents && metadata.agents.length > 0) {
        console.log('\nAgent 详情:');
        metadata.agents.forEach(agent => {
            console.log(`  - ${agent.id} (${agent.type})`);
            console.log(`    配置:`, JSON.stringify(agent.config, null, 4));
        });
    }
    console.log('');
}

/**
 * 演示链接管理
 */
async function demoLinkOperations(vfs) {
    console.log('--- 6. 链接管理 ---');

    // 创建多个有链接关系的文件
    const note1 = await vfs.createFile(
        'notes',
        '/concepts.md',
        `# 核心概念

VFS 相关概念说明。

参考: [[architecture]]
嵌入: ![[diagram-vfs]]
`
    );

    const note2 = await vfs.createFile(
        'notes',
        '/architecture.md',
        `# 架构设计

系统架构说明。

另见: [[concepts]]
相关: [[implementation]]
`
    );

    // 读取链接元数据
    const { metadata: meta1 } = await vfs.read(note1.id);
    console.log('文件链接信息:');
    console.log('  - 出链数量:', meta1.linkCount);
    console.log('  - 入链数量:', meta1.backlinkCount);

    if (meta1.outgoingLinks && meta1.outgoingLinks.length > 0) {
        console.log('\n出链详情:');
        meta1.outgoingLinks.forEach(link => {
            const type = link.type === 'embed' ? '📎 嵌入' : '🔗 引用';
            console.log(`  ${type} -> ${link.targetId}`);
        });
    }
    console.log('');
}

/**
 * 演示搜索功能
 */
async function demoSearchOperations(vfs) {
    console.log('--- 7. 搜索功能 ---');

    // 搜索 Markdown 文件
    const markdownFiles = await vfs.search('notes', {
        contentType: 'markdown'
    });
    console.log(`Markdown 文件数: ${markdownFiles.length}`);

    // 按名称搜索
    const projectFiles = await vfs.search('notes', {
        name: 'project'
    });
    console.log(`包含 "project" 的文件数: ${projectFiles.length}`);

    // 按类型搜索
    const directories = await vfs.search('notes', {
        type: 'directory'
    });
    console.log(`目录数: ${directories.length}`);

    // 组合搜索
    const results = await vfs.search('notes', {
        contentType: 'markdown',
        name: 'srs'
    });
    console.log(`组合搜索结果: ${results.length}`);
    console.log('');
}

/**
 * 演示模块管理
 */
async function demoModuleOperations(vfs) {
    console.log('--- 8. 模块管理 ---');

    // 列出所有模块
    const modules = vfs.listModules();
    console.log('已挂载的模块:', modules.join(', '));

    // 创建新模块
    await vfs.mount('projects', {
        description: '项目文档',
        meta: { owner: 'admin', category: 'work' }
    });
    console.log('✓ 新模块已挂载: projects');

    // 获取模块信息
    const moduleInfo = vfs.getModule('projects');
    console.log('模块信息:');
    console.log('  - 名称:', moduleInfo.name);
    console.log('  - 根节点ID:', moduleInfo.rootId);
    console.log('  - 描述:', moduleInfo.description);
    console.log('  - 创建时间:', moduleInfo.createdAt);

    // 在新模块中创建文件
    await vfs.createFile('projects', '/readme.md', '# 项目文档');
    console.log('✓ 在新模块中创建文件');
    console.log('');
}

/**
 * 演示事件监听
 */
async function demoEventOperations(vfs) {
    console.log('--- 9. 事件监听 ---');

    // 监听节点创建
    const unsubCreate = vfs.on('vnode:created', ({ vnode, derivedData }) => {
        console.log(`[事件] 节点创建: ${vnode.name} (${vnode.type})`);
        if (derivedData.clozes) {
            console.log(`  - SRS 卡片: ${derivedData.clozes.length}`);
        }
    });

    // 监听节点更新
    const unsubUpdate = vfs.on('vnode:updated', ({ vnode }) => {
        console.log(`[事件] 节点更新: ${vnode.id}`);
    });

    // 监听节点删除
    const unsubDelete = vfs.on('vnode:deleted', ({ vnode, deletedIds }) => {
        console.log(`[事件] 节点删除: ${vnode.id} (共 ${deletedIds.length} 个)`);
    });

    // 监听 SRS 更新
    const unsubSRS = vfs.on('srs:cards-updated', ({ nodeId, added, updated }) => {
        console.log(`[事件] SRS 更新: ${nodeId} (+${added}, ~${updated})`);
    });

    // 触发一些事件
    const testFile = await vfs.createFile(
        'notes',
        '/event-test.md',
        '# Event Test\n{{c1::Test Card}} ^clz-evt-001'
    );
    await vfs.write(testFile.id, '# Updated\n{{c1::Card 1}} ^clz-1\n{{c1::Card 2}} ^clz-2');
    await vfs.unlink(testFile.id);

    // 取消订阅
    unsubCreate();
    unsubUpdate();
    unsubDelete();
    unsubSRS();
    console.log('✓ 事件监听演示完成\n');
}

/**
 * 演示统计信息
 */
async function demoStatistics(vfs) {
    console.log('--- 10. 统计信息 ---');

    // 获取系统统计
    const stats = await vfs.getStats();
    console.log('系统统计:');
    console.log('  - 总节点数:', stats.totalNodes);
    console.log('  - 文件数:', stats.totalFiles);
    console.log('  - 目录数:', stats.totalDirectories);
    console.log('  - Providers:', stats.providers.join(', '));

    console.log('\n各模块统计:');
    Object.entries(stats.modules).forEach(([name, moduleStats]) => {
        console.log(`  ${name}:`);
        console.log(`    - 节点: ${moduleStats.nodeCount}`);
        console.log(`    - 文件: ${moduleStats.files}`);
        console.log(`    - 目录: ${moduleStats.directories}`);
    });
    console.log('');
}

/**
 * 演示导入导出
 */
async function demoBackupOperations(vfs) {
    console.log('--- 11. 导入导出 ---');

    // 导出模块
    const exportData = await vfs.exportModule('notes');
    console.log('✓ 模块导出完成');
    console.log('导出数据:');
    console.log('  - 模块名:', exportData.module.name);
    console.log('  - 节点数:', exportData.nodes.length);
    console.log('  - 数据大小:', JSON.stringify(exportData).length, 'bytes');

    // 导入模块（演示用，实际会创建新模块）
    // await vfs.importModule(exportData);
    console.log('(导入操作已跳过)\n');
}

/**
 * 演示自定义 Provider
 */
async function demoCustomProvider(vfs) {
    console.log('--- 12. 自定义 Provider ---');

    // 导入 ContentProvider 基类
    const { ContentProvider } = await import('@itookit/vfs');

    // 创建自定义 Provider
    class HashtagProvider extends ContentProvider {
        constructor() {
            super('hashtag', { priority: 4 });
            this.hashtagRegex = /#([a-zA-Z0-9_\u4e00-\u9fa5]+)/g;
        }

        async read(vnode, options = {}) {
            const content = options.rawContent || '';
            const hashtags = new Set();
            let match;
            
            while ((match = this.hashtagRegex.exec(content)) !== null) {
                hashtags.add(match[1]);
            }

            return {
                content: null,
                metadata: {
                    hashtags: Array.from(hashtags),
                    hashtagCount: hashtags.size
                }
            };
        }

        async write(vnode, content, transaction) {
            return {
                updatedContent: content,
                derivedData: {}
            };
        }
    }

    // 注册自定义 Provider
    const hashtagProvider = new HashtagProvider();
    vfs.registerProvider(hashtagProvider);
    console.log('✓ 注册自定义 Provider: hashtag');

    // 更新类型映射
    vfs.providerRegistry.mapType('blog', ['plain', 'link', 'hashtag']);

    // 使用自定义 Provider
    const blogPost = await vfs.createFile(
        'notes',
        '/blog-post.md',
        `# 博客文章

这是一篇关于 #VFS 和 #JavaScript 的文章。

#编程 #技术分享
`,
        { contentType: 'blog' }
    );

    const { metadata } = await vfs.read(blogPost.id);
    console.log('Hashtag 信息:');
    console.log('  - 标签:', metadata.hashtags?.join(', '));
    console.log('  - 数量:', metadata.hashtagCount);
    console.log('');
}

/**
 * 演示错误处理
 */
async function demoErrorHandling(vfs) {
    console.log('--- 13. 错误处理 ---');

    try {
        // 尝试读取不存在的节点
        await vfs.read('non-existent-id');
    } catch (error) {
        console.log('✓ 捕获错误 (节点不存在):', error.message);
    }

    try {
        // 尝试创建重复路径
        await vfs.createFile('notes', '/duplicate.md', 'content 1');
        await vfs.createFile('notes', '/duplicate.md', 'content 2');
    } catch (error) {
        console.log('✓ 捕获错误 (路径已存在):', error.message);
    }

    try {
        // 尝试移动到无效路径
        const file = await vfs.createFile('notes', '/test-move.md', 'content');
        await vfs.move(file.id, 'invalid//path');
    } catch (error) {
        console.log('✓ 捕获错误 (无效路径):', error.message);
    }

    try {
        // 尝试卸载不存在的模块
        await vfs.unmount('non-existent-module');
    } catch (error) {
        console.log('✓ 捕获错误 (模块不存在):', error.message);
    }
    console.log('');
}

// 运行演示
runDemo()
    .then(() => {
        console.log('✅ 所有演示完成！');
    })
    .catch(error => {
        console.error('❌ 演示出错:', error);
    });
