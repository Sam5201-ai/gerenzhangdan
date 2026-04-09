const { getStorageManager } = require('./StorageManager.js');
const { getCloudApi } = require('./CloudApi.js');

class BillDataManager {
  constructor() {
    this.storageManager = getStorageManager();
    this.cloudApi = getCloudApi();
    this.BILL_LIST_KEY = 'installments';
    this.PAYMENT_HISTORY_KEY = 'payment_history';
  }
  
  // 获取账单列表
  async getBillList(options = {}) {
    const { useCache = true, maxAge = 30 * 60 * 1000 } = options;
    
    try {
      // 云端优先
      if (this.cloudApi.isEnabled()) {
        const resp = await this.cloudApi.call('bills.list');
        const rows = (resp && resp.data) ? resp.data : [];
        const bills = rows.map(r => ({
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
        await this.storageManager.setData(this.BILL_LIST_KEY, bills, { immediate: false });
        return bills;
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

      // 云端同步：逐条 upsert
      if (this.cloudApi.isEnabled()) {
        for (const b of bills || []) {
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

      if (this.cloudApi.isEnabled()) {
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

      if (this.cloudApi.isEnabled()) {
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
      }

      const bills = await this.getBillList({ useCache: false });
      const billIndex = bills.findIndex(bill => bill.id === billId);
      if (billIndex === -1) return { success: false, error: '账单不存在' };
      const updatedBill = { ...bills[billIndex], ...cleaned, updatedAt: new Date().toISOString() };
      bills[billIndex] = updatedBill;
      const success = await this.saveBillList(bills, { immediate: true, priority: 'high' });
      return success ? { success: true, bill: updatedBill } : { success: false, error: '保存失败' };
    } catch (error) {
      console.error('更新账单失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 删除账单
  async deleteBill(billId) {
    try {
      if (this.cloudApi.isEnabled()) {
        await this.cloudApi.call('bills.delete', { id: billId });
        const bills = await this.getBillList({ useCache: false });
        const idx = bills.findIndex(b => b.id === billId);
        if (idx >= 0) bills.splice(idx, 1);
        await this.storageManager.setData(this.BILL_LIST_KEY, bills, { immediate: false });
        return { success: true };
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
        if (cloudRecord?.id) {
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
      if (this.cloudApi.isEnabled()) {
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
        const history = rows.map(r => {
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
        await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, history, { immediate: false });
        return history;
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
        console.log('[还款记录删除] 云端删除条件:', {
          cloudEnabled: true,
          localId: targetRecord.id,
          cloudId: targetRecord.cloudId || '',
          finalCloudRecordId: cloudRecordId || ''
        });
        if (cloudRecordId) {
          const deleteResp = await this.cloudApi.call('repayments.delete', { id: cloudRecordId });
          console.log('[还款记录删除] 云端删除成功:', {
            cloudRecordId,
            response: deleteResp
          });
        } else {
          console.warn('[还款记录删除] 未找到可删除的云端记录ID，已跳过云端删除:', targetRecord);
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
        try {
          const cloudRecordId = lastRecord.cloudId || lastRecord.id || await this.findCloudPaymentRecordId(lastRecord);
          console.log('[撤销还款] 云端删除条件:', {
            cloudEnabled: true,
            localId: lastRecord.id,
            cloudId: lastRecord.cloudId || '',
            finalCloudRecordId: cloudRecordId || ''
          });
          if (cloudRecordId) {
            const deleteResp = await this.cloudApi.call('repayments.delete', { id: cloudRecordId });
            console.log('[撤销还款] 云端删除成功:', {
              cloudRecordId,
              response: deleteResp
            });
          } else {
            console.warn('[撤销还款] 未找到可删除的云端记录ID，已跳过云端删除:', lastRecord);
          }
        } catch (error) {
          const msg = String(error && error.message ? error.message : error);
          if (msg.includes('Unknown action')) {
            console.warn('[撤销还款] 云端尚未部署 repayments.delete，已跳过远端删除');
          } else {
            console.error('[撤销还款] 云端删除失败:', error);
            throw error;
          }
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