# 离线缓存与自动同步方案

## 背景与目标

当前小程序三个主要页面（卡包 `pages/index`、分期 `pages/installments`、我的 `pages/settings`）的数据全部依赖云端实时拉取。Supabase 免费版停用（或断网）时：

- **读取断点**：`CardDataManager.getCardList()` 和 `BillDataManager.getBillList()` 在有历史登录态时（`cloudApi.isEnabled()` 只检查缓存的 openid+token，与云端是否可用无关）只走云端；请求失败直接进入外层 `catch` 返回 `[]`，已存在的本地缓存（`StorageManager`）完全没被利用 → 页面空白。
- **写入断点**：`addCard/updateCard/deleteCard/addBill/updateBill/deleteBill` 的云端分支失败后直接抛错返回失败，离线时无法增删改；`addPaymentRecord` 虽然本地先存，但下次 `getPaymentHistory` 云端拉取会用云端数据整体覆盖本地缓存，离线新增的还款记录丢失。

用户目标（已确认选择"查看 + 离线可增删改"）：
1. 云端停用/断网时，三个页面正常显示本地缓存数据；
2. 离线期间可正常新增/编辑/删除卡片、分期账单、还款记录（先存本地）；
3. 恢复联网后自动同步回云端，不丢数据、不产生重复。

## 总体设计：本地为准 + 待同步队列 + 拉取时同步

不改页面层代码，所有逻辑收在两个 DataManager 内。页面拿到的数据结构、方法签名保持不变。

### 核心机制（CardDataManager 与 BillDataManager 各自实现，不抽公共模块，保持与现有代码风格一致）

1. **待同步队列**：每个管理器在本地存储维护一个操作队列：
   - `CardDataManager`：`card_pending_ops`
   - `BillDataManager`：`bill_pending_ops`、`repayment_pending_ops`
   - 操作格式：`{ t: 'u' | 'd', id, at }`——`'u'` 表示"把本地列表中该 id 的当前数据上行 upsert"，`'d'` 表示"从云端删除该 id"。不在操作里存完整数据，同步时从本地列表按 id 取。
   - **合并规则**：对同一 id 追加新操作前先移除旧操作（最后一次操作为准，单人使用无并发冲突）。
2. **本地 id 约定**：`card_`/`bill_`/`payment_` 前缀 = 离线/本地创建、从未上云；云端 id 为 uuid。离线创建的数据同步成功后，把本地条目的 id **回映射**为云端 uuid。
3. **读路径（getCardList / getBillList / getPaymentHistory）**：
   - 云端可达：先执行 `syncPendingOps()`（把队列里的操作上行），再拉云端列表写缓存返回——恢复联网后的自动同步就发生在每次页面 onShow/下拉刷新触发的读取里；
   - 云端拉取失败：回退读本地缓存返回（StorageManager 现有逻辑本就支持返回已过期数据）；
   - 若队列里仍有未同步操作（同步失败，云端半可用）：把云端拉到的数据与本地未同步条目**合并**（`'u'` 的条目按 id 覆盖或追加，`'d'` 的 id 从结果中剔除）后写缓存返回，保证离线改动不被云端数据冲掉。
4. **写路径（云端分支失败时）**：回退为本地写入 + 记录待同步操作 + `wx.showToast('已保存到本地，联网后自动同步')`，并返回成功结果（页面无感）。具体：
   - `addCard`：生成 `card_` id 存本地 + 队列记 `{t:'u', id}`；`updateCard`：改本地 + 记 `'u'`；`deleteCard`：删本地，云端 uuid 记 `'d'`（`card_` 前缀只需清掉该 id 的 `'u'` 操作）。
   - `addBill/updateBill/deleteBill`：同上（`bill_` 前缀）。
   - `addPaymentRecord`：现已本地先存，失败时补记 `repayment_pending_ops` 的 `'u'` 即可。
   - `deletePaymentRecord/removeLastPaymentRecord`：本地删除已先行，云端删除失败时由"抛错"改为记 `'d'` 返回成功（本地已删，云端待删）。
5. **同步时的 id 回映射涟漪**（关键，防止关联断裂）：
   - 卡片 `card_xxx` 同步成功获得 uuid 后：更新本地卡片缓存条目 id → 更新本地账单缓存中引用它的 `cardId` → 更新卡片队列中该操作的 id；
   - 账单 `bill_xxx` 回映射后：更新本地账单条目 id → 更新本地还款记录缓存中的 `billId` → 更新账单队列操作 id；
   - 还款记录 `payment_xxx` 同步成功（`repayments.add` 返回 id）后：更新本地记录的 `id`/`cloudId` 并移除队列操作（现有 `addPaymentRecord` 已有同样的回写逻辑，复用其模式）。
6. **快速失败与退避（CloudApi 小改）**：
   - `requestJson` 的 `wx.request` 增加 `timeout: 8000`（默认 60 秒会导致离线读卡顿）；
   - CloudApi 增加会话级退避：任一云端调用失败后记 `_cloudDownUntil = Date.now() + 2分钟`，新增 `isCloudLikelyAvailable()` = `isEnabled() && Date.now() > _cloudDownUntil`。两个管理器的云端分支判断从 `isEnabled()` 换成 `isCloudLikelyAvailable()`，退避期内直接走本地，避免每次读取都白等 8 秒。`isEnabled()` 本身保留不动（其他调用方不受影响）。

## 修改文件清单

| 文件 | 改动 |
|---|---|
| `miniprogram/utils/CloudApi.js` | ① `requestJson` 加 `timeout: 8000`；② 新增 `_cloudDownUntil` 退避标记与 `isCloudLikelyAvailable()` 方法 |
| `miniprogram/utils/CardDataManager.js` | `getCardList` 云端失败回退本地缓存 + 拉取前同步队列；`addCard/updateCard/deleteCard` 失败回退本地写入并记队列；新增私有方法 `syncCardPendingOps()` / `markCardPending()` / `mergeCardPending()` |
| `miniprogram/utils/BillDataManager.js` | `getBillList` 同上；`addBill/updateBill/deleteBill` 同上；`getPaymentHistory` 拉取结果与本地未同步记录合并；`deletePaymentRecord/removeLastPaymentRecord` 云端删除失败改记队列；新增 `syncBillPendingOps()` / `syncRepaymentPendingOps()` 等私有方法 |

**不改**：三个页面 js、`StorageManager.js`、`UserManager.js`、`app.js`、云函数。

## 不改变的行为

- 云端正常时的所有流程：云端优先拉取、成功写入本地缓存、页面 setData 逻辑、订阅消息、还款提醒，全部原样；
- 队列只在"云端调用失败"或"退避期内"才写入，正常在线不产生队列数据；
- 首次安装且从未成功联网过的极端场景（本地无任何缓存）仍然为空，属不可避免。

## 数据一致性说明（需向用户明示的风险点）

- 单人使用、最后写入优先：若两台设备同时离线修改同一条数据，恢复联网后后同步的设备覆盖先同步的，无冲突提示（单人使用下概率极低）；
- 离线删除的是"仅存本地的未同步数据"时无需上云；删除"已上云数据"在恢复联网后自动在云端执行；
- 云端 Supabase 项目若被停用超过约 90 天存在数据删除风险，离线缓存在本地保留但云端没了就是没了——建议配合已部署的 GitHub Actions 保活机制使用。

## 验证方案（微信开发者工具 + 真机）

1. **在线回归**：正常联网下卡包/分期/我的三页加载、增删改卡片、增删改分期、确认还款、还款记录页、订阅提醒设置，行为与改前一致；Supabase Dashboard 确认数据正常上云。
2. **离线读取**：开发者工具 Network 面板切 Offline（或在 Supabase Dashboard 手动 Pause 项目），杀掉小程序重新打开 → 三页面应显示缓存数据而非空白；控制台出现 `[CardDataManager] 云端不可用，使用本地缓存` 类日志。
3. **离线写入**：离线状态下新增卡片 → 本地立即显示 + toast 提示；编辑分期、确认一笔还款、删除一条记录同样生效。
4. **恢复同步**：恢复网络（或 Resume 项目）→ 下拉刷新任一页面 → 打开 Supabase Dashboard 核对：离线新增的卡片/账单/还款记录已出现且 id 已回映射为 uuid；离线删除的记录已从云端消失；再杀进程重开，页面数据与云端一致、无重复行。
5. **退避验证**：离线状态下切回在线后 2 分钟内首次读取会重试云端，确认退避不会永久阻塞同步。
