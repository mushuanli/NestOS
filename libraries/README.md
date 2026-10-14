# 独立库源码

本目录的八个库各自保留 Git 仓库，通过 submodule 固定提交，统一参与主仓库的 pnpm workspace。业务包位于 `packages/`，应用宿主位于 `apps/`。

```bash
git submodule update --init --recursive -- libraries
pnpm install --frozen-lockfile
pnpm workspace:check --installed
pnpm --filter @itookit/vfs-core test
```

开发通过各库的公开 exports 消费源码；发布使用 publishConfig 的 dist 入口。主仓库对库间依赖统一应用 workspace 覆盖，各库独立开发和 npm 发布能力继续保留。

更新库时先在相应仓库提交改动，再在主仓库记录新的 submodule 指针。其他 checkout 需要从独立仓库取得这些提交，因此新增提交应先推送到对应远端。

可选 npm 构建使用 `pnpm build:registry`，在独立目录安装发布版本；不会切换日常开发的依赖链接。详细配置、锁文件与发布流程见 [独立库接入](../doc/design/npm-library-consumption.md)。
