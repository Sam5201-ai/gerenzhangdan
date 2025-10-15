const { getStorageManager } = require('./StorageManager.js');

class BillDataManager {
  constructor() {
    this.storageManager = getStorageManager();
    this.BILL_LIST_KEY = 'installments';
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
      
      // 数据迁移：确保所有账单都有字符串ID
      let needsMigration = false;
      bills = bills.map(bill => {
        if (typeof bill.id === 'number' || !bill.id) {
          needsMigration = true;
          return {
            ...bill,
            id: this.generateSecureId()
          };
        }
        return bill;
      });
      
      if (needsMigration) {
        await this.saveBillList(bills, { immediate: false });
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