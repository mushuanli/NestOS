# @itookit/sanbox

系统进程沙箱策略与启动计划。目录和包名沿用需求中的 `sanbox`；类型/API 使用 `Sandbox`。

- 根入口保持纯 TypeScript，不依赖 Node、DOM、Kernel、Flow 或 UI；Node 目录解析与探测只在 `/node` 入口。
- 策略来自可信宿主的目录授权。模型命令只能提供 argv/cwd/env，不能选择后端、授权目录或放宽网络。
- 缺少后端、平台不支持、探测失败均拒绝执行，禁止回退原生 shell。
- 本包不拥有进程生命周期。宿主必须统一包装 Bash 和 TTY，在确认进程停止后才释放目录授权。
- Tauri 通过 `native/` Rust crate 消费本包，底层规则共用 `src/runtime-policy.json`；Rust 必须从宿主授权重建命令，不能信任前端计划。
- 修改策略必须覆盖参数注入、符号链接、环境变量和原生边界测试。

```bash
pnpm --filter @itookit/sanbox test
pnpm --filter @itookit/sanbox typecheck
pnpm --filter @itookit/sanbox build
SANBOX_TEST_NATIVE=1 pnpm --filter @itookit/sanbox test
pnpm --filter tauri-app test:rust
```

原生测试显式开启后，后端不可用即失败，不能静默跳过。macOS 验证需在 macOS 主机执行。
接入设计见 [系统沙箱](../../doc/design/system-sandbox.md)。
