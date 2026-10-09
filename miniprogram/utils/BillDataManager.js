const { getStorageManager } = require('./StorageManager.js');
const { getCloudApi } = require('./CloudApi.js');

class BillDataManager {
  constructor() {
    this.storageManager = getStorageManager();
    this.cloudApi = getCloudApi();
    this.BILL_LIST_KEY = 'installments';
    this.PAYMENT_HISTORY_KEY = 'payment_history';
    this.BILL_PENDING_KEY = 'bill_pending_ops';
    this.REPAYMENT_PENDING_KEY = 'repayment_pending_ops';
  }

  // ========== 离线待同步队列（云端失败时记录，恢复联网后自动上行） ==========

  // 读取待同步操作队列，格式：[{ t: 'u'|'d', id, at }]
  getPendingOps(key) {
    try {
      const ops = wx.getStorageSync(key);
      return Array.isArray(ops) ? ops : [];
    } catch (e) {
      return [];
    }
  }

  setPendingOps(key, ops) {
    try {
      wx.setStorageSync(key, ops);
    } catch (e) {
      console.warn('[BillDataManager] 保存待同步队列失败', e);
    }
  }

  // 追加待同步操作；同一 id 只保留最新一条（单人使用，最后操作为准）
  markPending(key, t, id) {
    if (!id) return;
    const ops = this.getPendingOps(key).filter(op => op.id !== id);
    ops.push({ t, id, at: Date.now() });
    this.setPendingOps(key, ops);
  }

  // 离线保存成功的统一提示
  toastOfflineSaved() {
    wx.showToast({ title: '已离线保存，联网后自动同步', icon: 'none', duration: 2000 });
  }

  // 读取本地缓存的账单列表（不走云端，用于同步/合并）
  async getBillListLocalOnly() {
    const local = this.storageManager.getLocalData(this.BILL_LIST_KEY);
    return (local && Array.isArray(local.data)) ? local.data : [];
  }

  // 同步读取本地缓存（供页面首屏秒开渲染，不发起任何网络请求）
  getBillListCacheSync() {
    const local = this.storageManager.getLocalData(this.BILL_LIST_KEY);
    return (local && Array.isArray(local.data)) ? local.data : [];
  }

  // 同步读取本地缓存的还款记录（供页面秒开，不发网络请求）
  getPaymentHistoryCacheSync() {
    const local = this.storageManager.getLocalData(this.PAYMENT_HISTORY_KEY);
    return (local && Array.isArray(local.data)) ? local.data : [];
  }

  // 读取本地缓存的还款历史（不走云端，用于同步/合并）
  async getPaymentHistoryLocalOnly() {
    const local = this.storageManager.getLocalData(this.PAYMENT_HISTORY_KEY);
    return (local && Array.isArray(local.data)) ? local.data : [];
  }

  // 把本地待上行账单合并进云端拉取结果（防止离线改动被云端数据覆盖）
  mergePendingIntoBills(pulled) {
    const ops = this.getPendingOps(this.BILL_PENDING_KEY);
    if (!ops.length) return pulled;
    let merged = Array.isArray(pulled) ? pulled.slice() : [];
    // 注意：getBillListLocalOnly 是 async，同步上下文中直接调用会拿到 Promise，
    // 必须用同步的 getLocalData 读取本地缓存（否则迭代时抛 TypeError 导致整个云端读取失败）
    const local = this.storageManager.getLocalData(this.BILL_LIST_KEY);
    const localList = (local && Array.isArray(local.data)) ? local.data : [];
    for (const op of ops) {
      if (op.t === 'd') {
        merged = merged.filter(b => b.id !== op.id);
      }
    }
    for (const op of ops) {
      if (op.t !== 'u') continue;
      const localItem = localList.find(b => b.id === op.id);
      if (!localItem) continue;
      const idx = merged.findIndex(b => b.id === op.id);
      if (idx >= 0) merged[idx] = localItem;
      else merged.push(localItem);
    }
    return merged;
  }

  // 把本地未上云的还款记录（payment_ 前缀 id = 离线新增）合并进云端拉取结果，并应用离线删除
  mergePendingIntoPayments(pulled) {
    let merged = Array.isArray(pulled) ? pulled.slice() : [];
    const ops = this.getPendingOps(this.REPAYMENT_PENDING_KEY);
    for (const op of ops) {
      if (op.t === 'd') {
        merged = merged.filter(p => p.id !== op.id && p.cloudId !== op.id);
      }
    }
    const local = this.storageManager.getLocalData(this.PAYMENT_HISTORY_KEY);
    const localList = (local && Array.isArray(local.data)) ? local.data : [];
    for (const item of localList) {
      if (!(typeof item.id === 'string' && item.id.startsWith('payment_'))) continue;
      const idx = merged.findIndex(p => p.id === item.id);
      if (idx >= 0) merged[idx] = item;
      else merged.push(item);
    }
    return merged;
  }

  // 本地账单 id（bill_ 前缀）在云端创建成功后，回映射为云端 uuid，并同步还款历史中的引用
  async remapBillAfterUpsert(oldId, cloudRow) {
    if (!oldId || !cloudRow || !cloudRow.id || cloudRow.id === oldId) return;
    const billList = await this.getBillListLocalOnly();
    const updated = billList.map(b => (b.id === oldId ? {
      ...b,
      id: cloudRow.id,
      createdAt: cloudRow.created_at || b.createdAt || new Date().toISOString(),
      updatedAt: cloudRow.updated_at || b.updatedAt || new Date().toISOString()
    } : b));
    await this.storageManager.setData(this.BILL_LIST_KEY, updated, { immediate: false });
    // 队列中引用旧 id 的操作同步更新
    const ops = this.getPendingOps(this.BILL_PENDING_KEY).map(op => (op.id === oldId ? { ...op, id: cloudRow.id } : op));
    this.setPendingOps(this.BILL_PENDING_KEY, ops);
    // 还款历史缓存中引用该账单的 billId 一并更新
    await this.remapBillIdInPayments(oldId, cloudRow.id);
  }

  // 更新本地还款历史缓存中引用旧账单 id 的 billId
  async remapBillIdInPayments(oldBillId, newBillId) {
    try {
      const history = await this.getPaymentHistoryLocalOnly();
      if (history.some(p => p.billId === oldBillId)) {
        const updated = history.map(p => (p.billId === oldBillId ? { ...p, billId: newBillId } : p));
        await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, updated, { immediate: false });
      }
    } catch (e) {
      console.warn('[BillDataManager] 更新还款历史中的账单引用失败', e);
    }
  }

  // 将账单待同步队列上行到云端；全部成功返回 true，任一失败返回 false（剩余操作保留待下次）
  async syncBillPendingOps() {
    let ops = this.getPendingOps(this.BILL_PENDING_KEY);
    if (!ops.length) return true;

    let allDone = true;
    for (const op of ops.slice()) {
      try {
        if (op.t === 'u') {
          const billList = await this.getBillListLocalOnly();
          const item = billList.find(b => b.id === op.id);
          if (!item) {
            // 本地已不存在该条目，丢弃该操作
            ops = ops.filter(o => o !== op);
            this.setPendingOps(this.BILL_PENDING_KEY, ops);
            continue;
          }
          const isLocalId = typeof item.id === 'string' && item.id.startsWith('bill_');
          // card_id 为 uuid 外键：引用的卡片尚未上云（card_ 前缀）时暂缓上行，待卡片回映射后再上行
          if (item.cardId && String(item.cardId).startsWith('card_')) {
            const { getCardDataManager } = require('./CardDataManager.js');
            const cardOps = this.getPendingOps(getCardDataManager().CARD_PENDING_KEY);
            if (cardOps.length) {
              console.warn('[BillDataManager] 账单引用的卡片尚未上云，稍后自动重试', item.id);
              allDone = false;
              continue;
            }
            // 卡片待同步队列已空 = 引用的卡片已丢失（永远无法上云回映射），
            // 置空引用后照常上行（等同云端 on delete set null 语义），避免永久阻塞同步
            console.warn('[BillDataManager] 账单引用的卡片已丢失，置空卡片引用后上行', item.id);
            item.cardId = null;
          }
          const resp = await this.cloudApi.call('bills.upsert', {
            bill: {
              id: isLocalId ? undefined : item.id,
              card_id: item.cardId || null,
              card_name: item.cardName || null,
              total_amount: item.totalAmount ? Number(String(item.totalAmount).replace(/,/g, '')) : 0,
              installment_count: Number(item.totalCount || 0),
              per_payment_amount: item.monthlyPayment ? Number(String(item.monthlyPayment).replace(/,/g, '')) : 0,
              payment_day: Number(item.paymentDate || 15),
              paid_installments: Number(item.paidCount || 0),
              remaining_installments: Number(item.remainingCount || (Number(item.totalCount || 0) - Number(item.paidCount || 0))),
              paid_amount: item.paidAmount ? Number(String(item.paidAmount).replace(/,/g, '')) : 0,
              remaining_amount: item.remainingAmount ? Number(String(item.remainingAmount).replace(/,/g, '')) : 0,
              last_payment_date: this.normalizeDateString(item.lastPaymentDate),
              status: item.status || 'active'
            }
          });
          if (isLocalId) {
            await this.remapBillAfterUpsert(item.id, resp && resp.data);
          }
          ops = ops.filter(o => o !== op);
          this.setPendingOps(this.BILL_PENDING_KEY, ops);
          console.log(`[BillDataManager] 待同步账单已上行: ${item.cardName || item.id}`);
        } else if (op.t === 'd') {
          // bill_ 前缀 = 从未上云的本地数据，无需云端删除
          if (!(typeof op.id === 'string' && op.id.startsWith('bill_'))) {
            await this.cloudApi.call('bills.delete', { id: op.id });
          }
          ops = ops.filter(o => o !== op);
          this.setPendingOps(this.BILL_PENDING_KEY, ops);
        }
      } catch (e) {
        // 连续失败达到 3 次的操作暂时搁置（保留在队列、数据不丢），
        // 不再阻塞后续操作与整体同步状态，避免单个坏数据卡死整个云端读取
        const failCount = (op.failCount || 0) + 1;
        ops = ops.map(o => (o === op ? { ...o, failCount } : o));
        this.setPendingOps(this.BILL_PENDING_KEY, ops);
        if (failCount >= 3) {
          console.warn(`[BillDataManager] 账单操作连续失败${failCount}次，暂时搁置（保留待后续重试）`, op.id, e);
          continue;
        }
        console.warn('[BillDataManager] 待同步操作上行失败，稍后自动重试', op, e);
        allDone = false;
        break;
      }
    }
    return allDone;
  }

  // 将还款记录待同步队列上行到云端；全部成功返回 true，任一失败返回 false
  async syncRepaymentPendingOps() {
    let ops = this.getPendingOps(this.REPAYMENT_PENDING_KEY);
    if (!ops.length) return true;

    let allDone = true;
    for (const op of ops.slice()) {
      try {
        if (op.t === 'u') {
          const history = await this.getPaymentHistoryLocalOnly();
          const item = history.find(p => p.id === op.id);
          if (!item) {
            // 本地已不存在该记录（可能已被离线删除），丢弃该操作
            ops = ops.filter(o => o !== op);
            this.setPendingOps(this.REPAYMENT_PENDING_KEY, ops);
            continue;
          }
          // bill_id/card_id 为 uuid 外键：引用的账单/卡片尚未上云时暂缓上行，待前者回映射后再上行
          const billRefLocal = item.billId && String(item.billId).startsWith('bill_');
          const cardRefLocal = item.cardId && String(item.cardId).startsWith('card_');
          if (billRefLocal || cardRefLocal) {
            const { getCardDataManager } = require('./CardDataManager.js');
            const cardMgr = getCardDataManager();
            // 引用仍待上云（对应队列非空）：稍后重试
            if (billRefLocal && this.getPendingOps(this.BILL_PENDING_KEY).length) {
              console.warn('[BillDataManager] 还款记录引用的账单尚未上云，稍后自动重试', item.id);
              allDone = false;
              continue;
            }
            if (cardRefLocal && this.getPendingOps(cardMgr.CARD_PENDING_KEY).length) {
              console.warn('[BillDataManager] 还款记录引用的卡片尚未上云，稍后自动重试', item.id);
              allDone = false;
              continue;
            }
            // 对应队列已空 = 引用已丢失（永远无法回映射），置空引用后照常上行，避免永久阻塞同步
            if (billRefLocal) {
              console.warn('[BillDataManager] 还款记录引用的账单已丢失，置空账单引用后上行', item.id);
              item.billId = null;
            }
            if (cardRefLocal) {
              console.warn('[BillDataManager] 还款记录引用的卡片已丢失，置空卡片引用后上行', item.id);
              item.cardId = null;
            }
          }
          const resp = await this.cloudApi.call('repayments.add', {
            record: {
              card_id: item.cardId || null,
              bill_id: item.billId || null,
              card_name: item.cardName,
              amount: item.amount ? Number(String(item.amount).replace(/,/g, '')) : 0,
              payment_date: this.normalizeDateString(item.paymentDate) || new Date().toISOString().slice(0, 10)
            }
          });
          const cloudRecord = resp && resp.data;
          if (cloudRecord && cloudRecord.id) {
            // 本地 payment_ id 回映射为云端 uuid
            const currentHistory = await this.getPaymentHistoryLocalOnly();
            const updatedHistory = currentHistory.map(p => (p.id === item.id ? { ...p, id: cloudRecord.id, cloudId: cloudRecord.id } : p));
            await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, updatedHistory, { immediate: false });
          }
          ops = ops.filter(o => o !== op);
          this.setPendingOps(this.REPAYMENT_PENDING_KEY, ops);
          console.log('[BillDataManager] 待同步还款记录已上行');
        } else if (op.t === 'd') {
          // payment_ 前缀 = 从未上云的本地记录，无需云端删除
          if (!(typeof op.id === 'string' && op.id.startsWith('payment_'))) {
            await this.cloudApi.call('repayments.delete', { id: op.id });
          }
          ops = ops.filter(o => o !== op);
          this.setPendingOps(this.REPAYMENT_PENDING_KEY, ops);
        }
      } catch (e) {
        const failCount = (op.failCount || 0) + 1;
        ops = ops.map(o => (o === op ? { ...o, failCount } : o));
        this.setPendingOps(this.REPAYMENT_PENDING_KEY, ops);
        if (failCount >= 3) {
          console.warn(`[BillDataManager] 还款操作连续失败${failCount}次，暂时搁置（保留待后续重试）`, op.id, e);
          continue;
        }
        console.warn('[BillDataManager] 还款待同步操作上行失败，稍后自动重试', op, e);
        allDone = false;
        break;
      }
    }
    return allDone;
  }

  // 依序同步：卡片 → 账单 → 还款记录（后者的外键引用依赖前者的 id 回映射）
  async syncAllPendingOps() {
    try {
      const { getCardDataManager } = require('./CardDataManager.js');
      await getCardDataManager().syncCardPendingOps();
    } catch (e) {
      console.warn('[BillDataManager] 卡片待同步操作上行失败，稍后自动重试', e);
    }
    const billSynced = await this.syncBillPendingOps();
    const repaymentSynced = await this.syncRepaymentPendingOps();
    return billSynced && repaymentSynced;
  }

  // 获取账单列表
  async getBillList(options = {}) {
    const { useCache = true, maxAge = 30 * 60 * 1000 } = options;
    
    try {
      // 云端优先：有登录态且未处于离线退避期时，先同步本地待同步操作，再从云端拉取
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          // 恢复联网后自动上行离线期间的改动（队列为空时是快速空操作）
          // 同步失败不阻塞读取：联网可用就拉云端，待上行数据通过 merge 合并进结果，
          // 避免队列中个别操作卡死导致云端数据永远拉不回来（读取与同步解耦）
          await this.syncAllPendingOps();

          {
            const resp = await this.cloudApi.call('bills.list');
            const rows = (resp && resp.data) ? resp.data : [];
            let bills = rows.map(r => ({
              id: r.id,
              cardId: r.card_id || '',
              cardName: r.card_name || '',
              totalAmount: r.total_amount != null ? String(r.total_amount) : '0',
              totalCount: r.installment_count || 0,
              monthlyPayment: r.per_payment_amount != null ? String(r.per_payment_amount) : '0',
              paymentDate: r.payment_day != null ? String(r.payment_day) : '15',
              paidCount: r.paid_installments || 0,
              remainingCount: r.remaining_installments || 0,
              paidAmount: r.paid_amount != null ? String(r.paid_amount) : '0',
              remainingAmount: r.remaining_amount != null ? String(r.remaining_amount) : '0',
              progress: 0,
              status: r.status || 'active',
              lastPaymentDate: r.last_payment_date || '',
              createdAt: r.created_at || new Date().toISOString(),
              updatedAt: r.updated_at || new Date().toISOString()
            }));

            // 极端情况：拉取成功但本地又产生了新的待同步操作，合并防止覆盖
            if (this.getPendingOps(this.BILL_PENDING_KEY).length) {
              bills = this.mergePendingIntoBills(bills);
            }

            // 写回本地缓存（避免离线时空白）
            await this.storageManager.setData(this.BILL_LIST_KEY, bills, { immediate: false });
            return bills;
          }
        } catch (cloudError) {
          // 云端不可用（停用/断网/超时）：回退到本地缓存，避免页面空白
          console.warn('[BillDataManager] 云端不可用，回退使用本地缓存', cloudError);
        }
      }

      let bills = await this.storageManager.getData(this.BILL_LIST_KEY, {
        useCache,
        maxAge
      });
      
      if (!bills || !Array.isArray(bills)) {
        bills = [];
      }
      
      // 数据迁移：确保所有账单都有字符串ID和cardId
      let needsMigration = false;
      let cardList = null;
      
      // 检查是否需要cardId迁移
      const hasOldData = bills.some(bill => !bill.cardId && bill.cardName);
      
      if (hasOldData) {
        try {
          const { getCardDataManager } = require('./CardDataManager.js');
          const cardDataManager = getCardDataManager();
          cardList = await cardDataManager.getCardList() || [];
        } catch (error) {
          console.warn('获取卡片列表失败，跳过cardId迁移:', error);
          cardList = [];
        }
      }
      
      bills = bills.map(bill => {
        let updatedBill = { ...bill };
        
        // 迁移ID
        if (typeof bill.id === 'number' || !bill.id) {
          needsMigration = true;
          updatedBill.id = this.generateSecureId();
        }
        
        // 迁移cardId：为没有cardId的旧数据补充cardId
        if (!bill.cardId && bill.cardName && cardList) {
          needsMigration = true;
          
          // 通过卡片名称匹配cardId
          const matchedCard = cardList.find(card => {
            if (!card.name) return false;
            
            const billCardName = bill.cardName.toLowerCase();
            const cardName = card.name.toLowerCase();
            
            // 银行关键词匹配
            const keywords = ['招商', '工商', '建设', '农业', '中国', '交通', '民生', '光大', '华夏', '平安', '兴业', '浦发', '中信', '广发'];
            for (const keyword of keywords) {
              if (billCardName.includes(keyword) && cardName.includes(keyword)) {
                return true;
              }
            }
            
            return false;
          });
          
          if (matchedCard) {
            updatedBill.cardId = matchedCard.id;
            console.log(`为账单 "${bill.cardName}" 补充cardId: ${matchedCard.id}`);
          }
        }
        
        return updatedBill;
      });
      
      if (needsMigration) {
        await this.saveBillList(bills, { immediate: false });
        console.log('账单数据迁移完成，更新了cardId字段');
      }
      
      return bills;
    } catch (error) {
      console.error('获取账单列表失败:', error);
      return [];
    }
  }
  
  // 保存账单列表
  async saveBillList(bills, options = {}) {
    const { immediate = false, priority = 'normal', markDirty = true } = options;
    
    try {
      await this.storageManager.setData(this.BILL_LIST_KEY, bills, {
        immediate,
        priority,
        markDirty
      });

      // 云端同步：逐条 upsert（数据量通常不大）
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        let cloudSyncFailed = false;
        for (const b of bills || []) {
          if (cloudSyncFailed) {
            // 云端已失败：剩余条目全部记入待同步队列，恢复联网后自动上行
            this.markPending(this.BILL_PENDING_KEY, 'u', b.id);
            continue;
          }
          try {
            await this.cloudApi.call('bills.upsert', {
              bill: {
                id: b.id && String(b.id).startsWith('bill_') ? undefined : b.id,
                card_id: b.cardId || null,
                card_name: b.cardName || null,
                total_amount: b.totalAmount ? Number(String(b.totalAmount).replace(/,/g, '')) : 0,
                installment_count: Number(b.totalCount || 0),
                per_payment_amount: b.monthlyPayment ? Number(String(b.monthlyPayment).replace(/,/g, '')) : 0,
                payment_day: Number(b.paymentDate || 15),
                paid_installments: Number(b.paidCount || 0),
                remaining_installments: Number(b.remainingCount || (Number(b.totalCount || 0) - Number(b.paidCount || 0))),
                paid_amount: b.paidAmount ? Number(String(b.paidAmount).replace(/,/g, '')) : 0,
                remaining_amount: b.remainingAmount ? Number(String(b.remainingAmount).replace(/,/g, '')) : 0,
                last_payment_date: this.normalizeDateString(b.lastPaymentDate),
                status: b.status || 'active'
              }
            });
          } catch (cloudError) {
            console.warn('[BillDataManager] 云端同步失败，剩余条目已记入待同步队列', cloudError);
            this.markPending(this.BILL_PENDING_KEY, 'u', b.id);
            cloudSyncFailed = true;
          }
        }
      }

      return true;
    } catch (error) {
      console.error('保存账单列表失败:', error);
      return false;
    }
  }
  
  // 添加账单
  async addBill(billData) {
    try {
      const cleaned = this.validateAndCleanBill(billData);

      // 云端优先：由云端生成 uuid id
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          const resp = await this.cloudApi.call('bills.upsert', {
            bill: {
              card_id: cleaned.cardId || null,
              card_name: cleaned.cardName || null,
              total_amount: cleaned.totalAmount ? Number(String(cleaned.totalAmount).replace(/,/g, '')) : 0,
              installment_count: Number(cleaned.totalCount || 0),
              per_payment_amount: cleaned.monthlyPayment ? Number(String(cleaned.monthlyPayment).replace(/,/g, '')) : 0,
              payment_day: Number(cleaned.paymentDate || 15),
              paid_installments: Number(cleaned.paidCount || 0),
              remaining_installments: Number(cleaned.remainingCount || (Number(cleaned.totalCount || 0) - Number(cleaned.paidCount || 0))),
              paid_amount: cleaned.paidAmount ? Number(String(cleaned.paidAmount).replace(/,/g, '')) : 0,
              remaining_amount: cleaned.remainingAmount ? Number(String(cleaned.remainingAmount).replace(/,/g, '')) : 0,
              last_payment_date: this.normalizeDateString(cleaned.lastPaymentDate),
              status: cleaned.status || 'active'
            }
          });

          const r = resp?.data;
          const newBill = {
            ...cleaned,
            id: r.id,
            createdAt: r.created_at || new Date().toISOString(),
            updatedAt: r.updated_at || new Date().toISOString()
          };
          const bills = await this.getBillList({ useCache: false });
          bills.push(newBill);
          await this.storageManager.setData(this.BILL_LIST_KEY, bills, { immediate: false });
          return { success: true, bill: newBill };
        } catch (cloudError) {
          // 云端不可用：回退为本地保存，联网后自动同步
          console.warn('[BillDataManager] 云端添加账单失败，回退为本地保存', cloudError);
          this.toastOfflineSaved();
        }
      }

      const bills = await this.getBillList({ useCache: false });
      const newBill = {
        ...cleaned,
        id: this.generateSecureId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      bills.push(newBill);
      const success = await this.saveBillList(bills, { immediate: true, priority: 'high' });
      if (success && this.cloudApi.isEnabled()) {
        // 云端不可用（退避期/断网）：记入待同步队列，联网后自动上行
        this.markPending(this.BILL_PENDING_KEY, 'u', newBill.id);
      }
      return success ? { success: true, bill: newBill } : { success: false, error: '保存失败' };
    } catch (error) {
      console.error('添加账单失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 更新账单
  async updateBill(billId, updateData) {
    try {
      const cleaned = this.validateAndCleanBill(updateData);

      // bill_ 前缀 = 从未上云的本地账单，直接走本地更新（云端 uuid 外键不接受本地 id）
      const isLocalOnlyId = typeof billId === 'string' && billId.startsWith('bill_');

      if (!isLocalOnlyId && this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          const resp = await this.cloudApi.call('bills.upsert', {
            bill: {
              id: billId,
              card_id: cleaned.cardId || null,
              card_name: cleaned.cardName || null,
              total_amount: cleaned.totalAmount ? Number(String(cleaned.totalAmount).replace(/,/g, '')) : 0,
              installment_count: Number(cleaned.totalCount || 0),
              per_payment_amount: cleaned.monthlyPayment ? Number(String(cleaned.monthlyPayment).replace(/,/g, '')) : 0,
              payment_day: Number(cleaned.paymentDate || 15),
              paid_installments: Number(cleaned.paidCount || 0),
              remaining_installments: Number(cleaned.remainingCount || (Number(cleaned.totalCount || 0) - Number(cleaned.paidCount || 0))),
              paid_amount: cleaned.paidAmount ? Number(String(cleaned.paidAmount).replace(/,/g, '')) : 0,
              remaining_amount: cleaned.remainingAmount ? Number(String(cleaned.remainingAmount).replace(/,/g, '')) : 0,
              last_payment_date: this.normalizeDateString(cleaned.lastPaymentDate),
              status: cleaned.status || 'active'
            }
          });

          const r = resp?.data;
          const bills = await this.getBillList({ useCache: false });
          const idx = bills.findIndex(b => b.id === billId);
          const updatedBill = {
            ...(idx >= 0 ? bills[idx] : {}),
            ...cleaned,
            id: r?.id || billId,
            updatedAt: r?.updated_at || new Date().toISOString()
          };
          if (idx >= 0) bills[idx] = updatedBill;
          else bills.push(updatedBill);
          await this.storageManager.setData(this.BILL_LIST_KEY, bills, { immediate: false });
          return { success: true, bill: updatedBill };
        } catch (cloudError) {
          // 云端不可用：回退为本地更新，联网后自动同步
          console.warn('[BillDataManager] 云端更新账单失败，回退为本地更新', cloudError);
          this.toastOfflineSaved();
        }
      }

      const bills = await this.getBillList({ useCache: false });
      const billIndex = bills.findIndex(bill => bill.id === billId);
      if (billIndex === -1) return { success: false, error: '账单不存在' };
      const updatedBill = { ...bills[billIndex], ...cleaned, updatedAt: new Date().toISOString() };
      bills[billIndex] = updatedBill;
      const success = await this.saveBillList(bills, { immediate: true, priority: 'high' });
      if (success && this.cloudApi.isEnabled()) {
        // 云端不可用（退避期/断网）或本地账单未上云：记入待同步队列
        this.markPending(this.BILL_PENDING_KEY, 'u', billId);
      }
      return success ? { success: true, bill: updatedBill } : { success: false, error: '保存失败' };
    } catch (error) {
      console.error('更新账单失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 删除账单
  async deleteBill(billId) {
    try {
      // bill_ 前缀 = 从未上云的本地账单，无需云端删除
      const isLocalOnlyId = typeof billId === 'string' && billId.startsWith('bill_');

      if (!isLocalOnlyId && this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          await this.cloudApi.call('bills.delete', { id: billId });
          const bills = await this.getBillList({ useCache: false });
          const idx = bills.findIndex(b => b.id === billId);
          if (idx >= 0) bills.splice(idx, 1);
          await this.storageManager.setData(this.BILL_LIST_KEY, bills, { immediate: false });
          return { success: true };
        } catch (cloudError) {
          // 云端不可用：回退为本地删除，联网后自动同步
          console.warn('[BillDataManager] 云端删除账单失败，回退为本地删除', cloudError);
          this.toastOfflineSaved();
        }
      }

      const bills = await this.getBillList({ useCache: false });
      const billIndex = bills.findIndex(bill => bill.id === billId);

      if (billIndex === -1) {
        return { success: false, error: '账单不存在' };
      }

      bills.splice(billIndex, 1);

      const success = await this.saveBillList(bills, {
        immediate: true,
        priority: 'high'
      });

      if (success) {
        if (this.cloudApi.isEnabled()) {
          if (isLocalOnlyId) {
            // 从未上云的本地账单：清除可能的待上行操作即可
            const ops = this.getPendingOps(this.BILL_PENDING_KEY).filter(op => !(op.id === billId && op.t === 'u'));
            this.setPendingOps(this.BILL_PENDING_KEY, ops);
          } else {
            // 云端不可用（退避期/断网）：记入待同步删除队列，联网后自动补删
            this.markPending(this.BILL_PENDING_KEY, 'd', billId);
          }
        }
        return { success: true };
      } else {
        return { success: false, error: '保存失败' };
      }
    } catch (error) {
      console.error('删除账单失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 根据ID获取账单
  async getBillById(billId) {
    try {
      const bills = await this.getBillList();
      return bills.find(bill => bill.id === billId) || null;
    } catch (error) {
      console.error('获取账单失败:', error);
      return null;
    }
  }
  
  // 验证和清理账单数据
  validateAndCleanBill(billData) {
    const totalAmount = this.normalizeMoneyValue(billData.totalAmount || '0');
    const monthlyPayment = this.normalizeMoneyValue(billData.monthlyPayment || '0');
    const paidAmount = this.normalizeMoneyValue(billData.paidAmount || '0');
    const remainingAmount = this.normalizeMoneyValue(billData.remainingAmount || (Number(totalAmount) - Number(paidAmount)));

    const cleaned = {
      cardId: billData.cardId || '',
      cardName: billData.cardName || '',
      totalAmount,
      totalCount: parseInt(billData.totalCount) || 0,
      monthlyPayment,
      paymentDate: billData.paymentDate || '15',
      paidCount: parseInt(billData.paidCount) || 0,
      paidAmount,
      remainingAmount,
      progress: parseInt(billData.progress) || 0,
      status: billData.status || 'active',
      lastPaymentDate: billData.lastPaymentDate || ''
    };
    
    return cleaned;
  }
  
  // 生成安全ID
  generateSecureId() {
    return 'bill_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  normalizeMoneyValue(value) {
    const num = Number(String(value || '0').replace(/,/g, '')) || 0;
    return num.toFixed(2);
  }

  async getLocalPaymentHistory() {
    try {
      const history = await this.storageManager.getData(this.PAYMENT_HISTORY_KEY, {
        useCache: true,
        maxAge: 365 * 24 * 60 * 60 * 1000
      });
      return Array.isArray(history) ? history : [];
    } catch (error) {
      console.error('获取本地还款历史失败:', error);
      return [];
    }
  }
  
  // 添加还款记录
  async addPaymentRecord(billId, paymentData) {
    try {
      const paymentHistory = await this.getLocalPaymentHistory();
      const resolvedCardId = await this.resolveCardIdForPayment(billId, paymentData);
      const createdAt = paymentData.createdAt || new Date().toISOString();
      
      const newRecord = {
        id: this.generatePaymentId(),
        cloudId: '',
        billId: billId,
        cardId: resolvedCardId || '',
        amount: paymentData.amount,
        paymentDate: paymentData.paymentDate,
        currentPeriod: paymentData.currentPeriod,
        totalPeriods: paymentData.totalPeriods,
        cardName: paymentData.cardName,
        cardStyle: paymentData.cardStyle || 'blue',
        cardNumber: paymentData.cardNumber || '',
        createdAt,
        confirmedAt: createdAt
      };
      
      paymentHistory.push(newRecord);
      paymentHistory.sort((a, b) => new Date(b.confirmedAt || b.createdAt || 0) - new Date(a.confirmedAt || a.createdAt || 0));
      
      await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, paymentHistory, {
        immediate: true,
        priority: 'high'
      });

      // 云端追加（独立明细表）
      if (this.cloudApi.isEnabled()) {
        if (!this.cloudApi.isCloudLikelyAvailable()) {
          // 云端处于退避期（断网/停用后2分钟内）：本地已保存，记入待同步队列
          this.markPending(this.REPAYMENT_PENDING_KEY, 'u', newRecord.id);
          this.toastOfflineSaved();
        } else {
          try {
            const resp = await this.cloudApi.call('repayments.add', {
              record: {
                card_id: resolvedCardId || null,
                bill_id: billId,
                card_name: paymentData.cardName,
                amount: paymentData.amount ? Number(String(paymentData.amount).replace(/,/g, '')) : 0,
                payment_date: this.normalizeDateString(paymentData.paymentDate) || new Date().toISOString().slice(0, 10)
              }
            });

            const cloudRecord = resp?.data || null;
            if (!cloudRecord?.id) {
              throw new Error('云端返回数据不完整');
            }
            newRecord.cloudId = cloudRecord.id;
            newRecord.id = cloudRecord.id;
            const updatedHistory = paymentHistory.map(record => {
              if (record === newRecord) return { ...newRecord };
              return record;
            });
            await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, updatedHistory, {
              immediate: true,
              priority: 'high'
            });
            return { success: true, record: { ...newRecord } };
          } catch (cloudError) {
            // 云端不可用：本地已保存，记入待同步队列，联网后自动上行
            console.warn('[BillDataManager] 云端保存还款记录失败，转为离线保存', cloudError);
            this.markPending(this.REPAYMENT_PENDING_KEY, 'u', newRecord.id);
            this.toastOfflineSaved();
          }
        }
      }

      return { success: true, record: newRecord };
    } catch (error) {
      console.error('添加还款记录失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 获取还款历史记录
  async getPaymentHistory(options = {}) {
    const { useCache = true, maxAge = 30 * 60 * 1000 } = options;
    
    try {
      // 云端优先：有登录态且未处于离线退避期时，先同步本地待同步操作，再从云端拉取
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          // 恢复联网后自动上行离线期间的改动（队列为空时是快速空操作）
          // 同步失败不阻塞读取：联网可用就拉云端，待上行记录通过 merge 合并进结果，
          // 避免队列中个别操作卡死导致云端还款记录永远拉不回来（读取与同步解耦）
          await this.syncAllPendingOps();

          {
            let localHistory = [];
            try {
              const cached = await this.storageManager.getData(this.PAYMENT_HISTORY_KEY, {
                useCache: true,
                maxAge
              });
              localHistory = Array.isArray(cached) ? cached : [];
            } catch (e) {
              localHistory = [];
            }

            const resp = await this.cloudApi.call('repayments.list');
            const rows = (resp && resp.data) ? resp.data : [];
            let history = rows.map(r => {
              const localRecord = localHistory.find(item => item.id === r.id || item.cloudId === r.id) || null;
              return {
                id: r.id,
                cloudId: r.id,
                billId: r.bill_id || '',
                cardId: r.card_id || '',
                amount: r.amount != null ? String(r.amount) : '0',
                paymentDate: r.payment_date,
                cardName: r.card_name || '',
                currentPeriod: localRecord?.currentPeriod != null ? Number(localRecord.currentPeriod) : null,
                totalPeriods: localRecord?.totalPeriods != null ? Number(localRecord.totalPeriods) : null,
                cardStyle: localRecord?.cardStyle || 'blue',
                cardNumber: localRecord?.cardNumber || '',
                createdAt: r.created_at || localRecord?.createdAt || new Date().toISOString(),
                confirmedAt: localRecord?.confirmedAt || localRecord?.createdAt || r.created_at || new Date().toISOString()
              };
            });

            // 保留本地未上云记录（离线新增），并应用离线删除，防止被云端数据覆盖
            history = this.mergePendingIntoPayments(history);

            await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, history, { immediate: false });
            return history;
          }
        } catch (cloudError) {
          // 云端不可用（停用/断网/超时）：回退到本地缓存，避免页面空白
          console.warn('[BillDataManager] 云端不可用，回退使用本地缓存', cloudError);
        }
      }

      let history = await this.storageManager.getData(this.PAYMENT_HISTORY_KEY, {
        useCache,
        maxAge
      });
      
      if (!history || !Array.isArray(history)) {
        history = [];
      }
      
      return history;
    } catch (error) {
      console.error('获取还款历史失败:', error);
      return [];
    }
  }
  
  // 根据账单ID获取还款记录
  async getPaymentRecordsByBillId(billId) {
    try {
      const history = await this.getPaymentHistory();
      return history.filter(record => record.billId === billId);
    } catch (error) {
      console.error('获取账单还款记录失败:', error);
      return [];
    }
  }
  
  // 根据ID删除指定还款记录
  async deletePaymentRecord(recordId) {
    try {
      console.log('[还款记录删除] 开始删除指定记录, 入参ID:', recordId);
      if (!recordId) {
        console.warn('[还款记录删除] 删除中止: 缺少还款记录ID');
        return { success: false, error: '缺少还款记录ID' };
      }

      const paymentHistory = await this.getLocalPaymentHistory();
      console.log('[还款记录删除] 当前本地还款记录数量:', paymentHistory.length);
      const targetRecord = paymentHistory.find(record => record.id === recordId || record.cloudId === recordId);
      if (!targetRecord) {
        console.warn('[还款记录删除] 删除中止: 未找到目标记录', { recordId });
        return { success: false, error: '没有找到还款记录' };
      }

      console.log('[还款记录删除] 命中的本地目标记录:', targetRecord);
      const updatedHistory = paymentHistory.filter(record => record.id !== targetRecord.id && record.cloudId !== targetRecord.cloudId);
      console.log('[还款记录删除] 本地删除前后数量:', {
        before: paymentHistory.length,
        after: updatedHistory.length
      });
      await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, updatedHistory, {
        immediate: true,
        priority: 'high'
      });
      console.log('[还款记录删除] 本地 payment_history 已更新');

      if (this.cloudApi.isEnabled()) {
        const cloudRecordId = targetRecord.cloudId || targetRecord.id || await this.findCloudPaymentRecordId(targetRecord);
        // payment_ 前缀 = 从未上云的本地记录，无需云端删除
        const isLocalOnlyId = typeof cloudRecordId === 'string' && cloudRecordId.startsWith('payment_');
        console.log('[还款记录删除] 云端删除条件:', {
          cloudEnabled: true,
          localId: targetRecord.id,
          cloudId: targetRecord.cloudId || '',
          finalCloudRecordId: cloudRecordId || ''
        });
        if (cloudRecordId && !isLocalOnlyId) {
          if (this.cloudApi.isCloudLikelyAvailable()) {
            try {
              const deleteResp = await this.cloudApi.call('repayments.delete', { id: cloudRecordId });
              console.log('[还款记录删除] 云端删除成功:', {
                cloudRecordId,
                response: deleteResp
              });
            } catch (cloudError) {
              // 云端删除失败：本地已删除，记入待同步队列，联网后自动补删
              console.warn('[还款记录删除] 云端删除失败，已记入待同步队列', cloudError);
              this.markPending(this.REPAYMENT_PENDING_KEY, 'd', cloudRecordId);
            }
          } else {
            // 云端处于退避期（断网/停用后2分钟内）：记入待同步队列，联网后自动补删
            this.markPending(this.REPAYMENT_PENDING_KEY, 'd', cloudRecordId);
          }
        } else {
          console.warn('[还款记录删除] 未找到可删除的云端记录ID或记录未上云，已跳过云端删除:', targetRecord);
        }
      } else {
        console.warn('[还款记录删除] 当前未启用云端，同步删除已跳过');
      }

      return { success: true, removedRecord: targetRecord };
    } catch (error) {
      console.error('[还款记录删除] 删除指定记录失败:', error);
      return { success: false, error: error.message };
    }
  }

  // 删除还款记录（用于撤销还款）
  async removeLastPaymentRecord(billId) {
    try {
      console.log('[撤销还款] 开始删除最后一条还款记录, billId:', billId);
      const paymentHistory = await this.getLocalPaymentHistory();
      console.log('[撤销还款] 当前本地还款记录数量:', paymentHistory.length);
      
      // 找到该账单的最后一条还款记录
      const billRecords = paymentHistory.filter(record => record.billId === billId);
      console.log('[撤销还款] 当前账单命中的还款记录数量:', billRecords.length);
      if (billRecords.length === 0) {
        console.warn('[撤销还款] 删除中止: 没有找到还款记录', { billId });
        return { success: false, error: '没有找到还款记录' };
      }
      
      // 按时间排序，找到最新的记录
      billRecords.sort((a, b) => new Date(b.confirmedAt || b.createdAt || 0) - new Date(a.confirmedAt || a.createdAt || 0));
      const lastRecord = billRecords[0];
      console.log('[撤销还款] 识别到最后一条记录:', lastRecord);
      
      // 从历史记录中删除
      const updatedHistory = paymentHistory.filter(record => record.id !== lastRecord.id && record.cloudId !== lastRecord.cloudId);
      console.log('[撤销还款] 本地删除前后数量:', {
        before: paymentHistory.length,
        after: updatedHistory.length
      });
      
      await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, updatedHistory, {
        immediate: true,
        priority: 'high'
      });
      console.log('[撤销还款] 本地 payment_history 已更新');

      if (this.cloudApi.isEnabled() && (lastRecord.cloudId || lastRecord.id || lastRecord.billId)) {
        const cloudRecordId = lastRecord.cloudId || lastRecord.id || await this.findCloudPaymentRecordId(lastRecord);
        // payment_ 前缀 = 从未上云的本地记录，无需云端删除
        const isLocalOnlyId = typeof cloudRecordId === 'string' && cloudRecordId.startsWith('payment_');
        console.log('[撤销还款] 云端删除条件:', {
          cloudEnabled: true,
          localId: lastRecord.id,
          cloudId: lastRecord.cloudId || '',
          finalCloudRecordId: cloudRecordId || ''
        });
        if (cloudRecordId && !isLocalOnlyId) {
          if (this.cloudApi.isCloudLikelyAvailable()) {
            try {
              const deleteResp = await this.cloudApi.call('repayments.delete', { id: cloudRecordId });
              console.log('[撤销还款] 云端删除成功:', {
                cloudRecordId,
                response: deleteResp
              });
            } catch (error) {
              const msg = String(error && error.message ? error.message : error);
              if (msg.includes('Unknown action')) {
                console.warn('[撤销还款] 云端尚未部署 repayments.delete，已跳过远端删除');
              } else {
                // 云端删除失败：本地已删除，记入待同步队列，联网后自动补删
                console.warn('[撤销还款] 云端删除失败，已记入待同步队列', error);
                this.markPending(this.REPAYMENT_PENDING_KEY, 'd', cloudRecordId);
              }
            }
          } else {
            // 云端处于退避期（断网/停用后2分钟内）：记入待同步队列，联网后自动补删
            this.markPending(this.REPAYMENT_PENDING_KEY, 'd', cloudRecordId);
          }
        } else {
          console.warn('[撤销还款] 未找到可删除的云端记录ID或记录未上云，已跳过云端删除:', lastRecord);
        }
      } else {
        console.warn('[撤销还款] 当前未启用云端，或记录缺少云端定位信息，已跳过云端删除');
      }
      
      return { success: true, removedRecord: lastRecord };
    } catch (error) {
      console.error('[撤销还款] 删除还款记录失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  async findCloudPaymentRecordId(targetRecord) {
    if (!this.cloudApi.isEnabled() || !targetRecord) {
      console.warn('[还款记录删除] 跳过云端记录匹配: 云端未启用或目标记录为空', {
        cloudEnabled: this.cloudApi.isEnabled(),
        hasTargetRecord: !!targetRecord
      });
      return null;
    }

    try {
      console.log('[还款记录删除] 开始匹配云端记录ID, 目标记录:', targetRecord);
      const resp = await this.cloudApi.call('repayments.list');
      const rows = Array.isArray(resp?.data) ? resp.data : [];
      const targetAmount = Number(String(targetRecord.amount || '0').replace(/,/g, '')) || 0;
      const targetDate = this.normalizeDateString(targetRecord.paymentDate);
      const targetCreatedAt = targetRecord.confirmedAt || targetRecord.createdAt || '';
      console.log('[还款记录删除] 云端还款记录列表数量:', rows.length);
      console.log('[还款记录删除] 云端匹配条件:', {
        billId: targetRecord.billId || '',
        amount: targetAmount,
        paymentDate: targetDate || '',
        cardName: targetRecord.cardName || '',
        targetCreatedAt
      });

      const matched = rows.find(item => {
        const sameBillId = String(item.bill_id || '') === String(targetRecord.billId || '');
        const sameAmount = Number(item.amount || 0) === targetAmount;
        const sameDate = String(item.payment_date || '') === String(targetDate || '');
        const sameCardName = String(item.card_name || '') === String(targetRecord.cardName || '');
        const sameCreatedAt = targetCreatedAt && item.created_at
          ? Math.abs(new Date(item.created_at).getTime() - new Date(targetCreatedAt).getTime()) < 60 * 1000
          : true;
        return sameBillId && sameAmount && sameDate && sameCardName && sameCreatedAt;
      });

      if (matched) {
        console.log('[还款记录删除] 已匹配到云端记录:', matched);
      } else {
        console.warn('[还款记录删除] 未匹配到云端记录');
      }

      return matched?.id || null;
    } catch (error) {
      console.warn('[还款记录删除] 匹配云端还款记录ID失败:', error);
      return null;
    }
  }

  // 生成还款记录ID
  generatePaymentId() {
    return 'payment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // 解析还款记录对应的 cardId：优先使用调用入参，其次通过 billId 反查账单
  async resolveCardIdForPayment(billId, paymentData) {
    if (paymentData && paymentData.cardId) return paymentData.cardId;
    if (!billId) return null;
    try {
      const bill = await this.getBillById(billId);
      return bill?.cardId || null;
    } catch (e) {
      return null;
    }
  }

  // 统一日期格式：支持 YYYY-MM-DD / YYYY年MM月DD日 / ISO 字符串
  normalizeDateString(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    // 1) YYYY-MM-DD
    const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ymd) {
      const y = ymd[1];
      const m = ymd[2].padStart(2, '0');
      const d = ymd[3].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // 2) YYYY年MM月DD日
    const cn = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (cn) {
      const y = cn[1];
      const m = cn[2].padStart(2, '0');
      const d = cn[3].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // 3) ISO 或可被 Date 解析
    const dt = new Date(raw);
    if (!isNaN(dt.getTime())) {
      return dt.toISOString().slice(0, 10);
    }

    return null;
  }
}

// 单例模式
let billDataManagerInstance = null;

function getBillDataManager() {
  if (!billDataManagerInstance) {
    billDataManagerInstance = new BillDataManager();
  }
  return billDataManagerInstance;
}

module.exports = {
  BillDataManager,
  getBillDataManager
};