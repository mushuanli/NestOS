# @itookit/llm-flow

DAG 编排层：把 `llm-tasks` 的 LLM 任务单元连成动态图（route / loop / spawn / supervisor / compensate / on_failure / budget），并持久化 Flow 定义。

```bash
pnpm --filter @itookit/llm-flow typecheck
pnpm --filter @itookit/llm-flow test
```

- 开发说明：[AGENTS.md](./AGENTS.md)
- API：[doc/llm-flow-api.md](../../doc/llm-flow-api.md)
- 设计：[doc/design/flow-execution-model.md](../../doc/design/flow-execution-model.md)

公共契约入口 `@itookit/llm-flow/contracts` 提供Flow/DAG、委派、模板和 Hook 契约，不会初始化运行时。新代码从所属模块导入；原 llm-common 和 common 的 LLM 兼容入口均已删除。本包实现已移除 common/llm-common 依赖。
