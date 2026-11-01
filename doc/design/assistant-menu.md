# 助手入口：待处理事件与快捷访问

顶部 NestOS 品牌位置打开助手菜单；手机底部导航增加同一入口。角标显示当前待处理事件组数，弹层默认展示最重要的三项，更多项目通过“查看全部”展开。开始页保留在菜单页脚，不再占用品牌点击动作。手机复用底部面板，并遵循聊天沉浸态和编辑时已有的导航收起规则。

## 参考与取舍

- [Notion Agent Inbox](https://www.notion.com/help/manage-your-inbox-with-notion-agent)：集中查看需要注意的通知，按类型和已读状态整理，保留回到原内容的入口。
- [Raycast Quicklinks](https://www.raycast.com/core-features/quicklinks)：将常用目录和目标固定在统一入口，支持编辑和移除。
- [Claude Cowork 定时任务](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)：任务执行与结果查看保持明确关联。

NestOS 采用“需要处理的事件 + 用户固定入口”，不增加自动生成快捷菜单、额外任务执行器或调用模型排序。优先级由现有执行事实决定；菜单只导航，不自动批准、回复、提交消息或启动扫描。

## 事件来源与已读

`ApplicationBackend.assistantOverview` 在认证用户的应用服务图内聚合轻量读模型，RPC 分类为 query。会话来源使用 repository 的 summaries、Kernel catalog 和 sessionActivity，不读取聊天正文、Task 全量日志，不调用 openSession。只显示用户会话对应的事件，排除内部子 Task；执行进度按会话合并。

同一 repository、Kernel 与数字分身授权服务实例的重叠概览读取共用一次在途投影，完成后立即释放，不缓存已完成结果；不同用户或授权实例不合并，每个调用者获得独立结果副本。诊断按同一 operationId 分别记录 sessions、scanners 和整体 project 阶段的耗时、结果、数量及安全错误分类，便于区分会话摘要与扫描器摘要的存储开销。

排序依次为等待审批或输入、执行阻塞、执行/扫描失败或扫描暂停、完成结果，同级按时间降序。任务执行中不重复展示之前一次的完成通知；同一状态的重复刷新不生成新未读项。角标按合并后的事件组计数，不等于底层交互条数。

数字分身的 `activitySummary` 只投影有权限的个人/组织空间、扫描器名称和每个扫描器最近一次运行状态，避免向导航返回证据、提示词或凭据。扫描完成/失败的事件进入对应运行记录；用户固定的扫描器入口进入对应规则卡片。

普通结果可以标为已读，查看成功后也保存已读版本；支持勾选多项、全选当前显示列表后一次清除（保存已读版本），展开全部后可全选所有可清除项。选择绑定事件 ID 与版本，刷新出现新版本时取消原选择，避免清除未查看的新结果；保存失败保留选择和原列表供重试。等待审批、输入和阻塞仍计入待处理，直到原任务解除。已读不等于执行批准。源读取失败时保留上一份结果并提示暂时无法更新；读取中显示省略号，不完整时显示问号或已知数量加号，不能把故障误报为零事件。当前不聚合原生远程 Harness 的所有后台通知，也不把数字分身抽取的日程事实混入执行通知。

## 快捷项

| 类型 | 身份与行为 |
| --- | --- |
| 当前页面 | 保存内部 workspace/resource 路由；可用于固定已打开的本地或远程会话 |
| 项目目录 | 保存项目 ID 与项目内相对路径；点击时重新解析项目，项目改名后沿用项目身份 |
| 项目新会话 | 打开 `draft:<projectId>`，复用现有项目草稿、输入和附件，不立即创建正式会话或发送内容 |
| 已有会话 | 先选择项目，再筛选本地会话标题；嵌套项目按最长路径归属，未归属会话单独列出，按 Session ID 打开；远程会话可从其导航菜单直接添加 |
| 扫描器 | 保存空间 ID 与扫描器 ID，先进入有权限的空间，再定位到对应规则卡片，不运行扫描 |

快捷访问列表与新增表单统一使用空格分隔的多关键词筛选：所有词都匹配、顺序不限，忽略大小写与全角/半角差异，不使用正则或模糊猜测。列表匹配名称、位置及可选的“搜索关键词”，显示匹配数量和无结果提示；输入只刷新结果区，不重建搜索框；搜索框内 Escape 先清空条件，再按一次关闭菜单。新增/编辑表单分别支持项目、项目内会话和扫描器筛选；项目切换或筛选排除旧会话后清除旧选择，避免误选。扫描器匹配空间名与名称。搜索是临时视图状态，不写用户配置；关键词与位置说明作为可选字段保存在原 v1 文档，兼容已有快捷项。

该交互参考 [Raycast List 的标题与关键词过滤](https://developers.raycast.com/api-reference/user-interface/list)与 [Linear 的列表内搜索](https://linear.app/docs/search)，不新增复杂查询语法或标签管理系统。

项目、会话、目录/文件、笔记、工具箱、智能体和数字分身导航的现有菜单提供“添加到快捷访问”；扫描器卡片也提供此动作。顶层导航仅用于切换页面，不提供加入快捷访问的入口。应用级 `assistant-actions` 传递所选目标，助手统一打开带名称/关键词的表单；已有同目标快捷项进入编辑，不重复添加。操作只保存个人快捷项，组织只读资源也可加入；不复制权限或启动任务。

快捷项可以新增、重命名、调整顺序和移除；移除不删除原资源。表单限制为内部导航与项目内相对目录，不能配置任意命令或外部脚本。最多保存 50 项。读取失败不覆盖已有配置，保存失败保留表单与原快捷项 ID，重试不重复添加。

个人快捷项和已读版本由既有 UI 文档 `nestos_assistant_menu_v1` 保存，走用户绑定的 readUiDocuments/writeUiDocuments；不使用全局浏览器 localStorage，也不写共享项目或组织定义。启动时与主题/工作台文档批量读取，事件订阅与刷新复用原有会话、Kernel、数字分身端口。

## 路由与生命周期

数字分身支持 `/workspace/<空间ID>/<页面>/<目标>`；旧的 `/sources` 等路由仍有效。扫描器链接使用 `sources/plan:<id>`，清除冲突筛选并翻页定位；运行通知使用 `runs/<runId>`，即使旧运行不在默认最近 50 条中也能显示。空间切换仍检查当前用户权限和未保存设置。

图标目录缺项时回退为“助手／标为已读”文字，并按图标记录一次 ASSISTANT_ICON_UNAVAILABLE，避免模板输出 undefined。弹层使用原生 dialog，支持 Escape、背景关闭、返回入口焦点和手机触摸滚动。销毁时清理事件订阅、定时器和新导航入口，并恢复原品牌 DOM；迟到的读取不会恢复已销毁菜单。读写与失败日志只含 operationId、阶段、结果、数量、错误分类与耗时，不记录标题、快捷路径、用户内容或密钥。

验证入口：app-core 的 [assistant-overview.test.ts](../../backend/app-core/tests/assistant-overview.test.ts)；app-shell 的 [assistant-menu.test.ts](../../ui/app-shell/tests/assistant-menu.test.ts)、[digital-twin-scan-list.test.ts](../../ui/app-shell/tests/digital-twin-scan-list.test.ts)、[digital-twin-workspaces.test.ts](../../ui/app-shell/tests/digital-twin-workspaces.test.ts)、[digital-twin-scanner-transport.test.ts](../../ui/app-shell/tests/digital-twin-scanner-transport.test.ts) 和 [http-full-shell.test.ts](../../ui/app-shell/tests/http-full-shell.test.ts)。
