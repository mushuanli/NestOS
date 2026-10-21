# image-tools

通用外部 Tool 包。核心工厂只通过 ToolUseContext 的授权 VFS、资产和回执端口读写；不得直接读取任意宿主文件或加入具体业务规则。Node 引擎使用 Sharp，浏览器 Canvas 引擎经 /browser 独立入口供 Web/Tauri 宿主装配；Node 入口不得加载此入口或 DOM 模块。

配方契约来自 image-parser/processing 的纯入口。缓存键包含输入内容、配方和引擎版本；复用回执前验证所有资产。保持原图不可变，不通过无限降低质量或缩小尺寸满足预算。验证命令与保护上限见 README.md。
