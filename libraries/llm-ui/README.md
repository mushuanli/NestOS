# @itookit/llm-ui

独立的原生 DOM LLM 界面库，包含聊天与 Flow。唯一直接运行时依赖为 `@itookit/mdxeditor`；不依赖 MindOS、Session、Kernel、Flow 执行包、VFS、框架或特定传输协议。

## npm 与源码消费

发布制品通过 npm 安装，根入口使用 dist JavaScript 和声明：

```bash
pnpm add @itookit/llm-ui @itookit/mdxeditor
```

源码位于 libraries/llm-ui。pnpm 工作区将该目录与应用纳入 packages 后，应用声明 `@itookit/llm-ui: workspace:*`，包 exports 自动指向 src；mdxeditor 也可作为源码工作区提供。无需生成 dist，也无需为 Session、Flow 执行包或其他 MindOS 包设置路径别名。

源码入口只使用自身相对模块和公开的 mdxeditor 包。外部 Vite/TypeScript 工程也可直接引用 vendored `src/index.ts` 或 `src/flow.ts`，并提供 mdxeditor 依赖；使用支持 TypeScript 与 CSS 的 bundler。构建工具脚本不进入源码运行依赖。

```ts
import { createChatView, createOperationLedger } from '@itookit/llm-ui';
import '@itookit/llm-ui/style.css';
import '@itookit/mdxeditor/style.css';

// Keep the ledger in the host, beyond any individual view.
const operations = createOperationLedger();
const view = await createChatView(container, {
    source, // synchronous getSnapshot() and subscribe()
    actions, // named Promise operations and reconcile(operationId)
    operations,
});

await view.flushDraft();
await view.destroy();
```

可运行的内存宿主组合见 [memory-host.ts](./examples/memory-host.ts)。它演示快照发布、提交值捕获、选择器、资源候选及 toolbar 的 update/destroy。MindOS 的 Session 和原生会话接入位于 `@itookit/llm-ui-adapter/independent`。

## Flow

Flow 是本库的一部分。聊天集成通过 features.flow 控制，默认关闭；只有启用并点击入口后才加载 Flow 代码：

```ts
const view = await createChatView(container, {
    source, actions, operations,
    features: { flow: true },
    flow: { source: flowSource, actions: flowActions, operations },
});
await view.setFlowEnabled(false);
await view.setFlowEnabled(true);
```

禁用隐藏入口并释放 Flow 视图，不取消后台执行。启用必须提供 flow 绑定；可在初始化时传入绑定但保持关闭。也可直接通过可选子入口单独创建 Flow 视图：

```ts
import { createFlowView, createOperationLedger } from '@itookit/llm-ui/flow';
import '@itookit/llm-ui/flow.css';

const flow = await createFlowView(container, {
    source: flowSource,
    actions: flowActions,
    operations: createOperationLedger(),
});
```

通用视图提供节点面板、端口连线、拖动、节点参数编辑、保存/运行/停止和执行输出。宿主通过 FlowSnapshot 投影节点类型、参数字段、端口、权限和运行状态，通过具名 callback 执行修改，不需要库理解具体插件名或业务模板。复杂节点检查器可通过 mountInspector 注入，并在卸载时释放。

节点编辑携带 expectedRevision；连线、保存和运行使用 graphRevision，它不随流式运行状态推进。取消固定 executionRef，unknown 通过同一宿主台账恢复核对。没有 action 的视图只读，销毁不停止执行。Flow 的存储、编译、运行和 MindOS 专有节点规则位于适配层及宿主。

## 宿主契约

- source 是唯一会话事实输入；读取不进行网络 I/O。快照及消息不可原地修改。一个 source 对应一次会话/分支观察绑定，多个窗口可各自绑定同一会话。
- `conversationId` 是跨绑定的稳定关联，`viewId` 是绑定实例身份。两者不代替授权。消息 revision 只在该消息变化时递增；snapshot revision 仅表示发布顺序。
- `accepted` 表示宿主接管提交内容、后续处理及失败恢复责任，不表示模型或任务已完成。内存宿主只保证实例寿命；持久宿主须提供持久接纳证据或可靠待发送记录。
- 只有关联 operationId 的 **confirmed 用户消息**可确认提交。optimistic 消息不清理草稿。accepted 清理对应草稿，正式用户消息出现后才替换临时气泡，并记录已经观察到正式消息，分页或重开不会复活临时卡片；assistant/tool 消息不会按 submissionId 合并。
- 有写操作的宿主必须实现 reconcile。unknown 不判失败、不自动重发，也禁止把同一待核对提交换新 ID 再发；查询不到记录仍可返回 unknown。
- 操作台账由宿主持有。`createOperationLedger({ initial, save })` 可接入持久化；register 保存成功后才派发操作，settle 保存成功后才发布结果。重新打开传入同一台账和持久草稿。
- 接纳确认不会被迟到网络异常降级。矛盾的终态回执通过台账 onError 交给适配层核对；UI 不采用最后到达者覆盖。
- edit/retry 携带目标消息 revision。宿主进行权威版本检查；产生分支后由宿主创建新的绑定和 ChatView。cancel 必须核对不透明 executionRef。
- 宿主负责 refresh、分页和增量之间的数据新鲜度与合并。递增本地 revision 不代表上游数据更新。

## 草稿与扩展

草稿包含独立 textRevision 与附件项 ID。附件资源 ID 可以复用，草稿项 ID 不复用。上传期间不能提交；移除或销毁后，迟到上传结果不能恢复附件。saveDraft 串行合并，flushDraft 包括调用前仍在防抖中的编辑，失败不会标记为已保存。

支持 approval、text、single-choice、multi-choice；请求事实状态与本窗口提交状态分别管理。复杂块使用显式登记的 `renderers`；注册代码是可信宿主扩展，不是沙箱。未知扩展显示占位，Markdown 围栏不能登记扩展。

Markdown 使用 literal HTML 策略及链接/图片协议限制；附件由 AssetProvider 经宿主权限边界读取。打印使用同一份已渲染内容。`searchResources` 接入文件提及，`selectors` 展示宿主选择器并在提交时捕获值，`mountToolbar` 接入应用动作。

隐藏暂停昂贵呈现，仍处理操作和草稿确认。destroy 幂等，尝试全部清理后汇总异常；它不关闭 source、操作台账或共享运行时，不取消后台任务。

## 验证

```bash
pnpm --filter @itookit/llm-ui typecheck
pnpm --filter @itookit/llm-ui test
pnpm --filter @itookit/llm-ui build
```

构建检查源码、JavaScript、声明和发布出口。工作区使用源码入口，发布 tarball 使用 dist 入口；消费类型使用 TypeScript bundler 解析。浏览器样式由宿主显式导入。
