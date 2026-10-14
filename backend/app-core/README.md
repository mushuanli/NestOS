# @itookit/app-core

Headless application core shared by Web, Tauri and CLI hosts.

## Responsibilities

- Platform-neutral Session file/directory services (`SessionFilesService`, `DirectoryMountService`, attachment mounts).
- Session route / browser projections and VFS tool context adapters.
- Shared Kernel composition: `createKernelRuntime()` owns `Kernel`, `createKernelAdaptersRuntime()`, Durable program registration and optional recovery.
- Shared Skill catalog synchronization: `syncSkillsToKernel()`.

## Host boundary

`app-core` must stay free of DOM, CSS, Tauri IPC and Node-only APIs. Hosts inject platform capabilities through `CreateKernelRuntimeOptions`:

- `systemFS`
- `storageResolver`
- `fileContextForSession`
- `configureSession`
- `skillSource*`
- `additionalTools`
- `beforeRecover`

`@itookit/app-shell` depends on this package and adds routing, Workbench, editors and theme. `apps/cli` depends on this package and adds YAML workflow compilation, CLI lifecycle commands, Node/OCI shell adapters and `RunStore`.
