# 同步宿主适配

连接 vfs-sync 端口与驱动公共能力。驱动不依赖本包。状态复用 SeqFile，不新增表。同步范围必须由宿主显式传入。

- shared 复用 SeqFile 控制 schema、租约机制和 FileLocal；平台文件应用不能抽象掉原子性差异。
- 浏览器根入口禁止导出 local，Node/POSIX 使用独立 `/local` 入口。
- local 要求 FULL 存储，文件/journal 与工作目录同文件系统；未知替换证据保留内容并阻塞，不猜测应用成功。

- HTTP 客户端实现归 piagent-driver；本包 `/http` 保留兼容重导出。浏览器与本地存储、协调器仍归本包。
