# 方案讨论：会话记录一次性读 与 journal 探测/事务合并

**状态**：待评审（未实施）。本文只做原理、实现方案与代码改动的设计，不含已落地的改动。

**背景数据来源**：`apps/cli/tests/fixtures/profile-boot-cost.ts`（临时 LocalFS + Node SQLite + CLI 装配）与一次「poll 成本」临时探针（跑完即删）。逻辑调用数不是 IPC 数，但桌面每逻辑调用 ≥1 次宿主往返，趋势一致。

## 0. 现状量化（两个方案的收益上限）

| 场景 | sidecar 逻辑调用 | 事务 | 事务信封（begin+probe+commit） | journal 探测 | `session.seq::record` 读 |
|---|---:|---:|---:|---:|---:|
| 启动（3 空 Session） | 697 | 157 | 471（67.6%） | 157（22.5%） | 15（2.2%） |
| 启动（3 Session + 9 终态 Task） | 814 | 175 | 525（64.5%） | 175（21.5%） | 15（1.8%） |
| **单次 poll**（3 终态 Task 会话，逐会话各一次） | 85~87 | 19 | 57（66%） | 19（22%） | **4（4.7%）** |

三条结论，先摆出来避免方向误判：

1. **事务信封是最大单项**（约 2/3 的逻辑调用）。桌面每事务 = `sidecar_begin` + 至少 1 次 `sidecar_select`（journal 探测）+ `sidecar_finish`；Node 侧是 `begin` + 探测 + `commit` 三次 `ISidecarDb` 调用。任何「减少事务」或「把信封折叠进一次宿主调用」的改动，都比逐条优化记录读更值钱。
2. **方案二（journal 探测）的量级明显大于方案一**：每次 poll 19 次探测（22%），启动 175 次（21.5%）。方案一在启动只占 1.8%，在 poll 占 4.7%。
3. **方案一里真正无风险的那部分**是「同一事务内重复读」——managed sweep 在**一个事务里**读两次会话记录（`managed-resources.ts:687-688`），同一连接、同一快照，可以直接记忆化，不需要跨事务传参。跨事务传参才是那条有正确性风险的路线，而它的收益只是把 poll 的 4 次降到 2 次左右。

改动前后对比基线见 [启动诊断](./startup-diagnostics.md#2026-09-27-第四轮跨-seqfile-批量读getentriesmany) 的第四轮数字（994 → 814）。

## 1. 方案一：会话记录一次性读

### 1.1 原理

`session.seq` 的 `record` 键是会话的权威状态（`SessionRecord`：`id` / `status` / `layout` / `closeMode` / `version` …）。每次事务开始时 Kernel 都要求「本宿主能理解这个会话的布局」，实现就是：

```ts
// packages/durable-kernel/src/infrastructure/seqfile/store-helpers.ts:324
export async function requireSessionTx(tx: ISeqFileTransaction, root: string): Promise<SessionRecord> {
    const value = await tx.getEntry(sessionPath(root), SESSION_KEY);   // 1 次记录读
    if (!value) throw new Error(`Session record missing at ${root}`);
    const record = decode<SessionRecord>(value);
    assertSessionLayout(record);                                       // 纯计算，无 IO
    return record;
}
```

它是**每个事务的前置条件重新确认**：因为事务是唯一可信的一致性边界（租约、CAS、authority fence 都在事务内判定），所以「上一个事务读到过」不能直接复用。24 个调用点分三类用途：

| 用途 | 典型调用点 | 是否可变 |
|---|---|---|
| 会话身份（`session.id`，用于事件/索引归属） | `store.ts:329/349`（写 shared 后追加事件）、`store.ts:703/725`（index 作用域校验） | 不可变 |
| 布局断言（`assertSessionLayout`，fail closed） | `store.ts:358`（`listShared` 的守卫事务）、`managed-resources.ts` 各命令 | 迁移时变 |
| 状态门禁（`status` / `closeMode`） | `store.ts:909`（`claimReady`）、`store.ts:1231`（`claimEffect`）、`managed-resources.ts:232/347/687` | **随时可变** |

成本模型（这是关键，容易高估收益）：

- 探测/读取发生在**已存在的事务内**时，省下的是 1 次 `sidecar_select`（≈1/86 次 poll 调用），**不省事务信封**。
- 只有「为了校验布局而单独开一个事务」的调用才省整个信封。最典型的是 `listShared`（`store.ts:358`）：先 `transaction(fs, tx => requireSessionTx(tx, root))` 只做布局断言，随后 `walkEntries` 又在事务外发起读取 → 两次事务，对 CLI/桌面是 6~8 次逻辑调用换来一次纯校验。

### 1.2 方案 A：事务内记忆化（推荐，低风险）

**原理**：同一个 `ISeqFileTransaction` 内，对同一 `root` 的会话记录读是幂等的——同一连接、同一快照，期间只有本事务自己的写入能改变它。因此可以在事务对象上做记忆化，并在**本事务写入会话记录时同步更新**记忆化值。

**实现方案**

```ts
// store-helpers.ts（示意）
const sessionMemo = new WeakMap<ISeqFileTransaction, Map<string, SessionRecord>>();

function memoFor(tx: ISeqFileTransaction): Map<string, SessionRecord> {
    let memo = sessionMemo.get(tx);
    if (!memo) { memo = new Map(); sessionMemo.set(tx, memo); }
    return memo;
}

export async function requireSessionTx(tx: ISeqFileTransaction, root: string): Promise<SessionRecord> {
    const memo = memoFor(tx), cached = memo.get(root);
    if (cached) return cached;
    const value = await tx.getEntry(sessionPath(root), SESSION_KEY);
    if (!value) throw new Error(`Session record missing at ${root}`);
    const record = decode<SessionRecord>(value);
    assertSessionLayout(record);
    const frozen = Object.freeze(record);      // 记忆化返回视为不可变；原地改会立刻抛错
    memo.set(root, frozen);
    return frozen;
}

/** 唯一允许写会话记录的入口：写入后同步记忆化，避免同事务再读一次。 */
export async function writeSessionTx(tx: ISeqFileTransaction, root: string, record: SessionRecord): Promise<void> {
    await tx.setEntry(sessionPath(root), SESSION_KEY, encode(record));
    memoFor(tx).set(root, Object.freeze(record));
}
```

**代码改动内容**

| 文件 | 改动 |
|---|---|
| `packages/durable-kernel/src/infrastructure/seqfile/store-helpers.ts` | `requireSessionTx` 加 `WeakMap<tx, Map<root, SessionRecord>>` 记忆化 + `Object.freeze`；新增 `writeSessionTx` |
| `packages/durable-kernel/src/infrastructure/seqfile/store.ts:122/245/273` | 三处 `tx.setEntry(sessionPath(...), SESSION_KEY, ...)` 改走 `writeSessionTx`（create / 状态迁移 / reopen） |
| `packages/durable-kernel/src/infrastructure/seqfile/store.ts:358` | `listShared` 的守卫事务与随后的 `walkEntries` 合并到一个事务：一次布局断言 + 一次前缀遍历（省 1 个事务信封） |
| `packages/durable-kernel/src/infrastructure/seqfile/managed-resources.ts:687-688`、`232/237`、`347/353` | 无需改动；同事务同 `root` 的第二次读自动命中记忆化 |

**正确性论证**

- 记忆化作用域 = 单个事务对象，`WeakMap` 随事务结束被回收，不跨事务、不跨连接，不存在「另一个进程写入不可见」问题。
- 事务内写入必须走 `writeSessionTx`（3 个写入点，已全部收敛）；若有人绕过它直接 `setEntry`，记忆化会读到旧值 → **必须在同文件加注释 + 一条「事务内写会话记录后再读必须看到新值」的回归**。
- `Object.freeze` 防止调用方原地修改（`task.currentAttempt` 那种原地改模式在会话记录上不存在，冻结可把未来的误用变成显式错误）。

**收益**（按实测推算）

| 位置 | 现状 | 改后 | 省 |
|---|---:|---:|---:|
| 每次 poll（每会话） | 4 次会话读 | 2~3 次 | 1~2 次/86 ≈ 1~2% |
| 每次 `listShared` | 2 个事务 | 1 个事务 | 3~4 次逻辑调用/调用 |
| 启动（3 会话） | 15 | 12~13 | 1~2%（仅 `listShared`-类守卫 + 同事务重复） |

### 1.3 方案 B：跨事务传参（风险高，不推荐单独做）

**原理**：把调用方已读到的 `SessionRecord` 传进后续事务，事务内不再读。这是仓库里已有的模式（`recoverSession(knownSession?)`、`FlowInvocationService.list(sessionId, stored?)`、`ContextGc.observeSession(sessionId, storage?)`）。

**实现方案**：拆成两个入口，只在**不可变切片**上允许传参：

```ts
/** 只含不可变事实：id + layout。绝不携带 status。 */
export interface SessionIdentity { readonly id: SessionId; readonly layout?: SessionLayout }

export async function requireSessionIdentityTx(tx, root, known?: SessionIdentity): Promise<SessionIdentity>;
export async function requireSessionStateTx(tx, root): Promise<SessionRecord>;   // 状态门禁永远读
```

调用点改动：`Kernel.poll` 已经读了 `session`（`kernel.ts:888` `store.sessionRecord`）→ 把 `SessionIdentity` 传给同一 tick 内的 `store.sweep` / `store.pendingOutbox` / `abortFencedReducers`；`Kernel.drain`（`kernel.ts:981`）已读 `session` → 传给 `claimReady`；`listTaskPage` / `listPendingInteractionTasks` / `listShared` 由外部传入 identity（Kernel 层持有）。

**为什么风险高**

- `status` / `closeMode` / `version` 是会话生命周期的可变量。另一进程可以 `closeSession`，而我们的 tick 里还拿着老记录 → `claimReady` 会把任务派给已关闭的会话。这正是「状态门禁必须每次读」的原因。
- `layout` 虽然只在迁移时变，但迁移可能是另一个宿主发起（`migration.status = 'pending'`），传参等于跳过 fail-closed 检查。
- 因此**只能把 `id`（+ 已在读时断言过的 layoutVersion）作为切片**，收益也随之缩水：poll 的 4 次里，2 次来自同事务重复（方案 A 已能吃下），剩下 2 次是不同事务（`poll` 的 `sessionRecord` + sweep 的 authority 读），省它们需要跨事务传 `id`，而调用方本来就有 `sessionId` 字符串——**用不着传记录，只要把「为了拿 id 而读记录」改成「用已知 id 校验」**即可：新增 `requireSessionIdTx(tx, root, expectedId)`，事务内只读一次记录比对 `id`（仍然读，但语义明确、可审计）。

### 1.4 回归与验收

- 新增 `session-open-cost.test.ts` 用例：同一事务内连续两次 `requireSessionTx` 只产生 1 次记录读（用 `backend.records.getRecordField` spy 计数）。
- 新增：事务内 `writeSessionTx` 之后再读必须看到新值；`Object.freeze` 后原地修改抛错。
- 新增：`listShared` 只开 1 个事务（spy `backend.records.transaction`）。
- 保持：布局损坏 / 未知 layoutVersion 仍 fail closed（现有用例）。
- **禁止**：传 `status` 的用例作为反例写进测试（「另一进程关闭会话后，本 tick 的状态门禁仍拒绝派发」）。

## 2. 方案二：journal 探测与事务合并

### 2.1 原理

rename 的原子性缺口：文件系统 `rename` 与 sidecar 记录迁移（`movePathData`）不在同一个原子单位里。于是 localfs 用 journal 记录「已开始、未必完成」的迁移：

- `records` 表中路径 `/__vfs_namespace_journal__` 的 `intent` 字段 = `{ id, fromPath, toPath }`；
- 完成/放弃后写 `rename-result/<id>` 并删除 `intent`。

**每个外层事务**都必须先探 `intent`，存在则在同一事务内推进恢复（补做 rename、迁移记录、写回执）：

```ts
// libraries/vfsdriver-local/src/localfs-backend.ts:78
this.records = new SidecarRecordStore(() => this.requireDb(), db => this.recoverRename(db), false);
// 探测本体（localfs-backend.ts:307）
const intent = await db.getRecordField(RENAME_JOURNAL, 'intent');
```

**为什么不能靠「实例内曾经干净」跳过**：另一个进程可以在本连接打开之后提交 `intent` 然后崩溃。这在 2026-09-14 的真实两进程 SIGKILL 事故里已经发生过一次（当时移除进程内干净缓存才修复），因此 `https://github.com/mushuanli/vfsdriver-local/blob/main/AGENTS.md` 明确禁止该做法。**任何跳过探测的方案都必须提供一个能看见「其他连接提交」的证据源**，否则不予考虑。

### 2.2 方案 2a：把探测折叠进 begin（零语义变化，推荐）

**原理**：探测必须执行，但**不必是一次独立的宿主往返**。桌面每事务现在是这样：

```
sidecar_begin(IPC) → sidecar_select(journal intent, IPC) → 业务 SQL(IPC) → sidecar_finish(IPC)
```

`sidecar_begin` 在 Rust 宿主内已经对 SQLite 执行 `BEGIN IMMEDIATE`，此时再执行一条本地的 `SELECT` 不会产生额外 IPC。把探测作为「begin 的可选参数」下推给宿主，探测次数不变，IPC 少 1 次/事务。

**实现方案**

1. 宿主（Rust）给 `sidecar_begin` 增加可选探测：`begin_with_probe(database, scope, probe?: { query, values })`，在刚 `BEGIN` 的事务内执行，把结果行随 `transactionId` 一起返回。宿主不认识 VFS 语义，只执行「通用探测查询」，journal 路径仍由驱动层给出（保持分层）。
2. `ISidecarDb` 端口增加可选能力：
   ```ts
   /** 在一次 begin 内先执行一条探测查询，避免额外的宿主往返。 */
   transactionWithProbe?<T>(probe: SidecarProbe, operation: (db: ISidecarDb, probeRows: Row[]) => Promise<T>): Promise<T>;
   ```
3. `SidecarRecordStore.runInTransaction`（`localfs-backend.ts:661`）优先走 `transactionWithProbe`，把 `probeRows` 交给 `beforeTransaction(scopedDb, probeRows)`；`beforeTransaction` 类型从 `(db) => Promise<void>` 改成 `(db, probeRows?) => Promise<void>`。
4. `recoverRename(db, probeRows?)`：`probeRows` 已给出 `intent` 时直接用（不再发 `getRecordField`）；未给出（后端不支持探测下推）时回退现有探测调用。

**代码改动内容**

| 文件 | 改动 |
|---|---|
| `apps/tauri-app/src-tauri/src/sidecar.rs` | `sidecar_begin` 增加 `probe: Option<ProbeSpec>` 参数；在事务内执行并返回 `probeRows`；`SidecarTransactions::begin` 签名扩展 |
| `apps/tauri-app/src/db/tauri-sql-sidecar.ts:314` | `transaction()` 改为带探测调用；`invoke('sidecar_begin', { …, probe })` |
| `https://github.com/mushuanli/vfsdriver-local/blob/main/src/db/sidecar-interface.ts` | 新增 `SidecarProbe`、`transactionWithProbe?`；`getRecordField` 探测型调用保持不变 |
| `https://github.com/mushuanli/vfsdriver-local/blob/main/src/localfs-backend.ts:78/307/661` | `beforeTransaction` 增加 `probeRows` 形参；`runInTransaction` 优先 `transactionWithProbe`；`recoverRename` 接受探测结果 |
| `https://github.com/mushuanli/vfsdriver-local/blob/main/src/db/sidecar.ts`、`apps/cli/src/sqlite-sidecar.ts` | `transactionWithProbe` 实现（本地调用，收益为少一次 JS 调用，SQL 不变） |
| `packages/app-shell/tests/fake-sidecar.ts`、`https://github.com/mushuanli/vfsdriver-local/blob/main/tests/{18,24,25}-*.test.ts` | fake/计数实现补齐新端口；`25-journal-probe.test.ts` 的 `journalProbes` 断言改为「begin 携带探测」计数 |
| `apps/cli/tests/20-kernel-ipc.test.ts` | 两进程 SIGKILL 场景保持在改后路径下通过（探测仍每事务执行） |

**收益**：桌面每事务少 1 次 IPC；启动 175 次、每次 poll 19 次探测不再各自成为一次往返（-21.5% / -22% IPC）。**SQL 与事务数不变**，`sidecarStats` 逻辑调用数只有在实现成「探测在 begin 内执行」时才下降——这一点必须写清楚，否则指标会被误读为「优化掉了检查」。

**风险**：端口签名变化涉及 3 个实现 + 4 处 fake/计数；`sidecar_begin` 返回值结构变化需要重建 Rust 宿主；`25-journal-probe.test.ts` 的若干断言要按新形态重写。

### 2.3 方案 2b：`PRAGMA data_version` 门控（可选叠加，收益最大）

**原理**：SQLite 明确文档化 `PRAGMA data_version` 的语义——**同一连接看不到自己的提交导致的递增，但其他连接的任何提交都会使其递增**。这正好是「另一个进程提交了 intent」的廉价证据源，且它是本地 pragma（无磁盘 IO、无 IPC）。

规则（在宿主内判定，随 begin 一起返回 `probeRequired`）：

```
需要探测 ⟺ 本连接自打开以来从未探测过（首次）
          ∨ 本连接上次探测后 data_version 变化（其他连接提交过任何东西）
          ∨ 本连接写过 intent 且尚未结算（本地标志）
```

**正确性论证**

- intent 只能由「另一个连接提交」（→ `data_version` 变化）或「本连接自己写」（→ 本地标志）产生；两者都被覆盖，因此不存在「有其他连接的 intent 而我们跳过探测」的情形。
- 该规则不依赖「实例内曾经干净」这一被否决的假设：它依赖的是数据库自己提供的跨连接变更计数。
- 保守性：其他连接的**任何**提交（例如 catalog 写入）都会让下一次事务探测一次——只多不少，不会漏。

**边界与风险（必须在评审里确认）**

1. **连接池**：桌面宿主用 `SqlitePool`，不同事务可能落在不同连接上；`data_version` 是**每连接**的。因此宿主必须按连接维护 `last_seen_data_version`，或在池层暴露连接标识。这是本方案最大的实现成本。
2. `data_version` 计数器回绕（32 位）与「数据库文件被替换」的极端场景。
3. 首次事务（连接刚打开）必须探测；连接被回收/重建后必须视为首次。
4. 回归必须覆盖 2026-09-14 那条真实事故：A 打开 → A 探测干净 → **B 提交 intent 并 SIGKILL** → A 的下一个事务仍必须发现并恢复。现有 `20-kernel-ipc.test.ts` / `25-journal-probe.test.ts` 已覆盖恢复本身，但要在「走了跳过分支」的路径上新增用例。

**收益**：启动 175 → ~1 次探测，每次 poll 19 → ~1 次；叠加 2a 后，稳态下 journal 探测既不是 IPC 也不是独立 SQL。

### 2.4 方案 2c（不推荐）：实例内「曾经干净」就直接跳过

即本次讨论里提到的「探测只在可能挂起 rename 时执行」的朴素版本。**不建议**：无跨进程证据源，等价于重新引入 2026-09-14 的缺陷。若一定要做「条件探测」，只能以 2b 的 `data_version`（或其他数据库级跨连接证据）为判据。

### 2.5 同方向的更大杠杆（供讨论，不在本次实施范围）

- **只读批量宿主原语**：`sidecar_read_batch(queries[])` = 宿主内 `BEGIN` + 探测 + 全部 `SELECT` + `COMMIT`，一次 IPC 完成一个只读事务。当前一个「非事务读」要 4 次 IPC（begin + probe + select + finish），这个原语把它压成 1 次。Kernel 的恢复/poll 大多是「探测 + N 读」的形状，适合声明式批量。代价：需要把读路径改写成「先声明查询集合」，而不是现在的读写交错决策式事务。
- **减少事务数**：写路径合并（与第四轮 `getEntriesMany` 同一思路），例如把同一 tick 内的多个小写事务合成一个。

## 3. 建议的推进顺序与决策点

| 顺序 | 事项 | 风险 | 收益（实测口径） |
|---|---|---|---|
| 1 | 方案 A 事务内记忆化 + `writeSessionTx` | 低（同事务等价） | poll 每会话 4 → 2~3 次读；`listShared` 2 事务 → 1 |
| 2 | 方案 2a 探测折叠进 begin | 中（跨 TS/Rust 端口） | 桌面每事务 -1 IPC；启动 -175、每次 poll -19 |
| 3 | `requireSessionIdTx`（用已知 id 校验，不传 status） | 低-中 | poll 再省 1~2 次读 |
| 4 | 方案 2b `data_version` 门控 | 中-高（连接池、跨进程回归） | 探测 SQL 稳态归零 |
| 5 | 只读批量宿主原语 | 高（读路径重写） | 只读事务 4 IPC → 1 |

**待决策问题**

1. 桌面宿主的连接池是否愿意为 `data_version` 维护「按连接」的状态？若不愿意，2b 直接放弃，只做 2a。
2. 是否接受为方案 A 引入 `writeSessionTx` 这一新写入入口（3 处调用点）？还是只做 `Object.freeze` + 注释，把写入约束留给评审？
3. 方案 1 的收益（启动 1.8%、poll 4.7%）是否值得动 Kernel 核心校验路径？若只做「同事务记忆化」，改动面很小（1 个函数 + 3 个写入点），可以独立评估。

## 4. 复现与验证命令

```bash
# 启动成本（含 session.seq / journal 的分操作与热点签名）
pnpm --filter @itookit/cli exec tsx tests/fixtures/profile-boot-cost.ts

# journal 探测语义（每事务探测一次、rename 后仍迁移）
pnpm --filter @itookit/vfsdriver-local test -- tests/25-journal-probe.test.ts

# 两进程 SIGKILL / 跨进程可见性
pnpm --filter @itookit/cli test -- tests/20-kernel-ipc.test.ts

# 会话恢复写入预算（干净恢复 0 写、记录读次数上限）
pnpm --filter @itookit/durable-kernel test -- src/session-open-cost.test.ts
```
