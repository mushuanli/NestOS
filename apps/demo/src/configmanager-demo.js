// demo.js - ConfigManager 使用示例

import { getConfigManager } from '@itookit/configmanager';

// [MODIFIED] 导入应用程序的默认配置数据
// 在实际项目中，这个文件可能位于你的 src/config 或 src/common 目录下
const LLM_DEFAULT_CONNECTIONS = [
    {
        id: 'default', name: 'Default OpenAI', provider: 'openai', apiKey: '',
        baseURL: 'https://api.openai.com/v1',
        availableModels: [{ id: 'gpt-4o', name: 'GPT-4o' }]
    },
    {
        id: 'deepseek-default', name: 'DeepSeek', provider: 'deepseek', apiKey: '',
        baseURL: 'https://api.deepseek.com',
        availableModels: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]
    }
];

const LLM_DEFAULT_AGENTS = [
    {
        id: 'default', name: 'Default Agent', icon: '🤖', description: '系统默认智能体',
        tags: ['default'],
        config: { connectionId: 'default', modelId: 'gpt-4o', systemPrompt: "You are a helpful assistant." },
        interface: { inputs: [{ name: "prompt", type: "string" }], outputs: [{ name: "response", type: "string" }] }
    },
    {
        id: 'default-temp', name: 'Temp Chat', icon: '⚡️', description: '一次性问答。',
        tags: ['default'], maxHistoryLength: 0,
        config: { connectionId: 'default', modelId: 'gpt-4o', systemPrompt: "You are a helpful assistant. Answer concisely." },
        interface: { inputs: [{ name: "prompt", type: "string" }], outputs: [{ name: "response", type: "string" }] }
    }
];


/**
 * 主演示函数
 */
async function runDemo() {
    console.log('=== ConfigManager Demo 开始 ===\n');

    // 1. 初始化 ConfigManager
    const configManager = getConfigManager();
    // [MODIFIED] 在初始化时注入默认配置
    await configManager.init({
        defaultConnections: LLM_DEFAULT_CONNECTIONS,
        defaultAgents: LLM_DEFAULT_AGENTS,
    });
    console.log('✓ ConfigManager 初始化完成\n');
    
    // 清理旧数据以确保演示环境干净
    await configManager.clearAllData();
    console.log('✓ 演示环境已清理\n');

    // 2. 创建模块和文件结构
    await demoFileOperations(configManager);

    // 3. 标签操作
    await demoTagOperations(configManager);

    // 4. 搜索功能
    await demoSearchOperations(configManager);

    // 5. SRS 卡片操作
    await demoSRSOperations(configManager);

    // 6. 任务管理
    await demoTaskOperations(configManager);

    // 7. LLM 配置
    await demoLLMOperations(configManager);

    // 8. 数据导入导出
    await demoBackupOperations(configManager);

    // 9. 事件监听
    await demoEventOperations(configManager);

    // 10. 统计信息
    await demoStatistics(configManager);
    
    // 11. 高级功能
    await demoAdvancedFeatures(configManager);
    
    // 12. 错误处理
    await demoErrorHandling(configManager);

    console.log('\n=== ConfigManager Demo 完成 ===');
}

/**
 * 演示文件和目录操作
 */
async function demoFileOperations(cm) {
    console.log('--- 1. 文件和目录操作 ---');

    // 创建目录
    const rootDir = await cm.createDirectory('notes', '/');
    console.log('创建根目录:', rootDir.path);

    const projectDir = await cm.createDirectory('notes', '/projects');
    console.log('创建项目目录:', projectDir.path);

    // 创建文件
    const file1 = await cm.createFile(
        'notes',
        '/projects/project1.md',
        '# 项目1\n\n这是项目1的内容。\n\n{{c1::重要概念}} ^clz-001'
    );
    console.log('创建文件:', file1.path);

    // 获取文件
    const retrievedFile = await cm.getNodeById(file1.id);
    console.log('获取文件内容:', retrievedFile.content.substring(0, 30) + '...');

    // 更新文件内容
    await cm.updateNodeContent(
        file1.id,
        '# 项目1（已更新）\n\n更新后的内容。\n\n{{c1::新概念}} ^clz-002'
    );
    console.log('✓ 文件内容已更新');

    // 重命名文件
    await cm.renameNode(file1.id, 'project1-renamed.md');
    console.log('✓ 文件已重命名');

    // 获取文件树
    const tree = await cm.getTree('notes');
    console.log('文件树结构:', JSON.stringify(tree, null, 2).substring(0, 200) + '...');

    // 获取所有文件
    const allFiles = await cm.getAllFiles('notes');
    console.log(`模块中共有 ${allFiles.length} 个文件\n`);
}

/**
 * 演示标签操作
 */
async function demoTagOperations(cm) {
    console.log('--- 2. 标签操作 ---');

    // 创建全局标签
    await cm.addGlobalTag('重要');
    await cm.addGlobalTag('待办');
    await cm.addGlobalTag('已完成');
    console.log('✓ 创建全局标签');

    // 获取所有标签
    const allTags = await cm.getAllTags();
    console.log('所有标签:', allTags.map(t => t.name).join(', '));

    // 为节点添加标签
    const files = await cm.getAllFiles('notes');
    if (files.length > 0) {
        await cm.addTagToNode(files[0].id, '重要');
        await cm.addTagToNode(files[0].id, '待办');
        console.log('✓ 为文件添加标签');

        // 获取节点的标签
        const nodeTags = await cm.getTagsForNode(files[0].id);
        console.log('文件的标签:', nodeTags.join(', '));

        // 批量添加标签
        const fileIds = files.map(f => f.id);
        await cm.addTagToNodes(fileIds, '项目');
        console.log('✓ 批量添加标签');
    }

    // 根据标签查找节点
    const nodesWithTag = await cm.findNodesByTag('重要');
    console.log(`带有"重要"标签的节点数: ${nodesWithTag.length}`);

    // 重命名标签
    await cm.renameTag('待办', '进行中');
    console.log('✓ 标签已重命名\n');
}

/**
 * 演示搜索功能
 */
async function demoSearchOperations(cm) {
    console.log('--- 3. 搜索功能 ---');

    // 全局文本搜索
    const searchResults = await cm.globalSearch('项目', {
        moduleName: 'notes',
        limit: 10
    });
    console.log(`搜索"项目"找到 ${searchResults.length} 个结果`);

    // 高级搜索
    const advancedResults = await cm.advancedSearch({
        keywords: '内容',
        tags: ['重要'],
        moduleName: 'notes',
        type: 'file'
    });
    console.log(`高级搜索找到 ${advancedResults.length} 个结果\n`);
}

/**
 * 演示 SRS 卡片操作
 */
async function demoSRSOperations(cm) {
    console.log('--- 4. SRS 卡片操作 ---');

    // 获取复习队列
    const reviewQueue = await cm.getReviewQueue({ limit: 5 });
    console.log(`待复习卡片数: ${reviewQueue.length}`);

    if (reviewQueue.length > 0) {
        const card = reviewQueue[0];
        console.log('第一张卡片内容:', card.content);

        // 回答卡片
        const updatedCard = await cm.answerCard(card.id, 'good');
        console.log('✓ 卡片已回答，下次复习时间:', updatedCard.dueAt);

        // 重置卡片
        await cm.resetCard(card.id);
        console.log('✓ 卡片已重置');
    }

    // 获取文档的所有卡片
    const files = await cm.getAllFiles('notes');
    if (files.length > 0) {
        const states = await cm.getStatesForDocument(files[0].id);
        console.log(`文档中的卡片数: ${states.size}\n`);
    }
}

/**
 * 演示任务管理
 */
async function demoTaskOperations(cm) {
    console.log('--- 5. 任务管理 ---');

    // 创建带任务的文件
    const taskFile = await cm.createFile(
        'notes',
        '/tasks.md',
        `# 任务列表
- [ ] @user1 [2024-01-01] 完成项目文档 ^task-001
- [x] @user2 [2024-01-02 to 2024-01-05] 代码审查 ^task-002
- [ ] @user1 [2024-01-03] 准备演示 ^task-003`
    );
    console.log('✓ 创建任务文件');
    
    // 手动触发一次内容更新来解析任务
    await cm.updateNodeContent(taskFile.id, taskFile.content);

    // 按用户查找任务
    const userTasks = await cm.findTasksByUser('user1');
    console.log(`用户 user1 的任务数: ${userTasks.length}`);

    // 按日期范围查找任务
    const startDate = new Date('2024-01-01');
    const endDate = new Date('2024-01-31');
    const dateTasks = await cm.findTasksByDateRange(startDate, endDate);
    console.log(`日期范围内的任务数: ${dateTasks.length}`);

    // 更新任务状态
    if (userTasks.length > 0) {
        await cm.updateTaskStatus(userTasks[0].id, 'done');
        console.log('✓ 任务状态已更新');

        // 批量更新任务状态
        const taskIds = userTasks.map(t => t.id);
        await cm.updateTasksStatus(taskIds, 'doing');
        console.log('✓ 批量更新任务状态\n');
    }
}

/**
 * 演示 LLM 配置
 */
async function demoLLMOperations(cm) {
    console.log('--- 6. LLM 配置 ---');

    // 获取所有连接
    const connections = await cm.llm.getConnections();
    console.log(`默认 LLM 连接数: ${connections.length}`);

    // 添加新连接
    const newConnection = {
        id: 'custom-openai',
        name: '自定义 OpenAI',
        provider: 'openai',
        apiKey: 'sk-xxx',
        baseURL: 'https://api.openai.com/v1',
        availableModels: [
            { id: 'gpt-4', name: 'GPT-4' },
            { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
        ]
    };
    await cm.llm.addConnection(newConnection);
    console.log('✓ 添加新连接');

    // 获取所有 Agent
    const agents = await cm.llm.getAgents();
    console.log(`Agent 数量: ${agents.length}`);

    // 添加新 Agent (非受保护)
    const newAgent = {
        id: 'custom-writer',
        name: '自定义写作助手',
        description: '帮助撰写文档',
        icon: '✍️',
        tags: ['写作', '助手'],
        config: {
            connectionId: 'custom-openai',
            modelId: 'gpt-4',
            systemPrompt: '你是一个专业的写作助手。',
            temperature: 0.7,
            maxTokens: 2000
        },
        interface: {
            inputs: [ { name: 'topic', type: 'string', description: '写作主题' } ],
            outputs: [ { name: 'content', type: 'string', description: '生成的内容' } ]
        }
    };
    await cm.llm.addAgent(newAgent);
    console.log('✓ 添加新 Agent');
    
    // 成功删除非受保护的Agent
    await cm.llm.removeAgent('custom-writer');
    console.log('✓ 成功删除非受保护的 Agent');

    // 获取工作流
    const workflows = await cm.llm.getWorkflows();
    console.log(`工作流数量: ${workflows.length}\n`);
}

/**
 * 演示数据导入导出
 */
async function demoBackupOperations(cm) {
    console.log('--- 7. 数据导入导出 ---');

    // 导出所有数据
    const exportedData = await cm.exportAllData();
    console.log('✓ 数据已导出');
    console.log('导出数据大小:', JSON.stringify(exportedData).length, 'bytes');

    // 获取存储信息
    const storageInfo = await cm.getStorageInfo();
    if (!storageInfo.error) {
        console.log('存储使用情况:');
        console.log(`  已使用: ${storageInfo.usageFormatted}`);
        console.log(`  总配额: ${storageInfo.quotaFormatted}`);
        console.log(`  使用率: ${storageInfo.percentUsed}%`);
    }

    // 注意：实际导入会清空现有数据，这里仅作演示
    // await cm.importAllData(exportedData);
    console.log('(导入操作已跳过，避免清空演示数据)\n');
}

/**
 * 演示事件监听
 */
async function demoEventOperations(cm) {
    console.log('--- 8. 事件监听 ---');

    // 订阅节点添加事件
    const unsubscribeNodeAdded = cm.on('node:added', (data) => {
        console.log('[事件触发]: 节点已添加', data.newNode.path);
    });

    // 订阅标签更新事件
    const unsubscribeTagsUpdated = cm.on('tags:updated', (data) => {
        console.log('[事件触发]: 标签已更新', data.action);
    });

    // 订阅 LLM 配置更新事件
    const unsubscribeLLMUpdated = cm.on('llm:config_updated', (data) => {
        console.log('[事件触发]: LLM 配置已更新', data.key);
    });

    // 触发一些操作来测试事件
    await cm.createFile('notes', '/event-test.md', '测试事件');
    await cm.addGlobalTag('事件测试');
    await cm.llm.addConnection({ id: 'event-conn', name: 'Event Test Conn', provider: 'openai' });


    // 取消订阅
    unsubscribeNodeAdded();
    unsubscribeTagsUpdated();
    unsubscribeLLMUpdated();
    console.log('✓ 事件监听演示完成\n');
}

/**
 * 演示统计信息
 */
async function demoStatistics(cm) {
    console.log('--- 9. 统计信息 ---');

    // 获取全局统计
    const globalStats = await cm.getStatistics();
    console.log('全局统计:');
    console.log(`  总节点数: ${globalStats.totalNodes}`);
    console.log(`  文件数: ${globalStats.totalFiles}`);
    console.log(`  目录数: ${globalStats.totalDirectories}`);
    console.log(`  标签数: ${globalStats.totalTags}`);
    console.log(`  任务数: ${globalStats.totalTasks}`);
    console.log(`  SRS 卡片数: ${globalStats.totalSRSCards}`);

    // 获取模块统计
    const moduleStats = await cm.getStatistics('notes');
    console.log('\n模块 "notes" 统计:');
    console.log(`  节点数: ${moduleStats.moduleStats.notes?.totalNodes || 0}`);
    console.log(`  文件数: ${moduleStats.moduleStats.notes?.files || 0}`);
    console.log(`  目录数: ${moduleStats.moduleStats.notes?.directories || 0}`);

    // 标签使用情况
    console.log('\n标签使用情况:');
    Object.entries(globalStats.tagUsage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([tag, count]) => {
            console.log(`  ${tag}: ${count} 次`);
        });
    console.log('');
}

/**
 * 额外演示：工作区和联系人
 */
async function demoAdvancedFeatures(cm) {
    console.log('--- 10. 高级功能 ---');

    // 工作区操作
    const workspace = cm.getWorkspace('my-workspace');
    console.log('✓ 获取工作区:', workspace.namespace);

    // 创建联系人
    const contact = await cm.createContact('contacts', {
        name: '张三',
        email: 'zhangsan@example.com',
        phone: '13800138000',
        company: 'ABC 公司',
        notes: '重要客户'
    });
    console.log('✓ 创建联系人:', contact.name);

    // 获取所有联系人
    const allContacts = await cm.getAllContacts('contacts');
    console.log(`联系人总数: ${allContacts.length}`);

    // 批量操作
    const files = await cm.getAllFiles('notes');
    if (files.length >= 2) {
        // 批量删除
        const filesToDelete = files.filter(f => f.path.startsWith('/projects'));
        if(filesToDelete.length > 0) {
            await cm.deleteNodes(filesToDelete.map(f => f.id));
            console.log(`✓ 批量删除 ${filesToDelete.length} 个节点`);
        }
    }
    console.log('');
}

/**
 * 错误处理演示
 */
async function demoErrorHandling(cm) {
    console.log('--- 11. 错误处理 ---');

    // 尝试删除受保护的 Agent
    try {
        await cm.llm.removeAgent('default');
    } catch (error) {
        console.log('✓ 捕获错误 (删除受保护 Agent):', error.message);
    }
    
    // 尝试删除受保护的 Tag
    try {
        await cm.deleteTag('default');
    } catch (error) {
        console.log('✓ 捕获错误 (删除受保护 Tag):', error.message);
    }

    try {
        // 尝试获取不存在的节点
        await cm.getNodeById('non-existent-id');
    } catch (error) {
        console.log('✓ 捕获错误 (获取不存在的节点):', error.message);
    }

    try {
        // 尝试创建重复路径
        await cm.createFile('notes', '/duplicate.md', '内容1');
        await cm.createFile('notes', '/duplicate.md', '内容2');
    } catch (error) {
        console.log('✓ 捕获错误 (路径冲突处理):', error.message);
    }
}

// 运行演示
runDemo()
    .then(() => {
        console.log('\n所有演示完成！');
    })
    .catch(error => {
        console.error('演示过程中出错:', error);
    });
