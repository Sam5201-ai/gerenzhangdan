const { getStorageManager } = require('./StorageManager.js');

class BillDataManager {
  constructor() {
    this.storageManager = getStorageManager();
    this.BILL_LIST_KEY = 'installments';
    this.PAYMENT_HISTORY_KEY = 'payment_history';
  }
  
  // 获取账单列表
  async getBillList(options = {}) {
    const { useCache = true, maxAge = 30 * 60 * 1000 } = options;
    
    try {
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
      return true;
    } catch (error) {
      console.error('保存账单列表失败:', error);
      return false;
    }
  }
  
  // 添加账单
  async addBill(billData) {
    try {
      const bills = await this.getBillList({ useCache: false });
      
      const newBill = {
        ...this.validateAndCleanBill(billData),
        id: this.generateSecureId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      bills.push(newBill);
      
      const success = await this.saveBillList(bills, {
        immediate: true,
        priority: 'high'
      });
      
      if (success) {
        return { success: true, bill: newBill };
      } else {
        return { success: false, error: '保存失败' };
      }
    } catch (error) {
      console.error('添加账单失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 更新账单
  async updateBill(billId, updateData) {
    try {
      const bills = await this.getBillList({ useCache: false });
      const billIndex = bills.findIndex(bill => bill.id === billId);
      
      if (billIndex === -1) {
        return { success: false, error: '账单不存在' };
      }
      
      const updatedBill = {
        ...bills[billIndex],
        ...this.validateAndCleanBill(updateData),
        updatedAt: new Date().toISOString()
      };
      
      bills[billIndex] = updatedBill;
      
      const success = await this.saveBillList(bills, {
        immediate: true,
        priority: 'high'
      });
      
      if (success) {
        return { success: true, bill: updatedBill };
      } else {
        return { success: false, error: '保存失败' };
      }
    } catch (error) {
      console.error('更新账单失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 删除账单
  async deleteBill(billId) {
    try {
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
    const cleaned = {
      cardId: billData.cardId || '',
      cardName: billData.cardName || '',
      totalAmount: billData.totalAmount || '0',
      totalCount: parseInt(billData.totalCount) || 0,
      monthlyPayment: billData.monthlyPayment || '0',
      paymentDate: billData.paymentDate || '15',
      paidCount: parseInt(billData.paidCount) || 0,
      paidAmount: billData.paidAmount || '0',
      remainingAmount: billData.remainingAmount || '0',
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
  
  // 添加还款记录
  async addPaymentRecord(billId, paymentData) {
    try {
      const paymentHistory = await this.getPaymentHistory({ useCache: false });
      
      const newRecord = {
        id: this.generatePaymentId(),
        billId: billId,
        amount: paymentData.amount,
        paymentDate: paymentData.paymentDate,
        currentPeriod: paymentData.currentPeriod,
        totalPeriods: paymentData.totalPeriods,
        cardName: paymentData.cardName,
        cardNumber: paymentData.cardNumber || '',
        createdAt: new Date().toISOString()
      };
      
      paymentHistory.push(newRecord);
      
      await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, paymentHistory, {
        immediate: true,
        priority: 'high'
      });
      
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
  
  // 删除还款记录（用于撤销还款）
  async removeLastPaymentRecord(billId) {
    try {
      const paymentHistory = await this.getPaymentHistory({ useCache: false });
      
      // 找到该账单的最后一条还款记录
      const billRecords = paymentHistory.filter(record => record.billId === billId);
      if (billRecords.length === 0) {
        return { success: false, error: '没有找到还款记录' };
      }
      
      // 按时间排序，找到最新的记录
      billRecords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const lastRecord = billRecords[0];
      
      // 从历史记录中删除
      const updatedHistory = paymentHistory.filter(record => record.id !== lastRecord.id);
      
      await this.storageManager.setData(this.PAYMENT_HISTORY_KEY, updatedHistory, {
        immediate: true,
        priority: 'high'
      });
      
      return { success: true, removedRecord: lastRecord };
    } catch (error) {
      console.error('删除还款记录失败:', error);
      return { success: false, error: error.message };
    }
  }
  
  // 生成还款记录ID
  generatePaymentId() {
    return 'payment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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