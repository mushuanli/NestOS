# @itookit/image-tools

通用外部 Tool 包，提供 `image.process@1`。业务 Flow 声明配方，平台通过授权资产端口提供数据；工具不访问任意宿主文件或联网。

Node 宿主使用 `createTools()`（Sharp），Web 与 Tauri 通过 `@itookit/image-tools/browser` 的 `createBrowserImageTools()` 共用 Canvas 适配器；自定义引擎仍可注入 `createImageTools(engine)`。两个 app 不互相依赖。浏览器入口只供宿主装配，Node 入口不加载它或 DOM 模块。CLI、HTTP、Web 和 Tauri 已在宿主装配边界注册；Flow 仍需在 capabilities 中显式授权 `image.process`。Node 构建必须把 Sharp 作为原生运行依赖保留，不能内联其原生加载器。

输入 `images` 支持标准 inline image_url 块、平台 asset 图片块，以及由 `context.vfs.readBinaryFile` 授权读取的 `{path}` 描述符。输入必须是真实 PNG、JPEG、WebP；路径入口是 Tool 接口，不自动扩展 Flow 的 images 表单格式。

处理参数、保护上限、资产归属及恢复规则见 [平台文档](../../doc/design/flow-image-processing.md)。

```sh
pnpm --filter @itookit/image-tools typecheck
pnpm --filter @itookit/image-tools test
```
