// pages/installments/installments.js
const { getCardDataManager } = require('../../utils/CardDataManager.js');
const { getBillDataManager } = require('../../utils/BillDataManager.js');

Page({
  data: {
    // 分期账单数据
    installments: [],
    
    // 今天的日期
    today: new Date().toISOString().split('T')[0],
    
    // 弹窗状态
    showInstallmentPopup: false,
    showStatsPopup: false,
    showConfirmPopup: false,
    popupScrollTop: 0, // 弹窗滚动位置
    confirmData: {
      actionType: '',
      installmentId: null,
      installmentIndex: null,
      title: '',
      message: '',
      icon: '',
      beforeCount: 0,
      afterCount: 0,
      paymentDate: ''
    },
    
    // 编辑状态
    editingInstallment: null,
    
    // 表单数据
    formData: {
      cardIndex: -1,
      totalAmount: '',
      totalCount: '',
      monthlyPayment: '',
      paymentDate: '15',
      paidCount: '0',
      remainingCount: '',
      paidAmount: '0',
      remainingAmount: '',
      lastPaymentDate: ''
    },
    
    // 卡片选项
    cardOptions: [
      { id: 1, name: '招商银行信用卡 (**** 8888)' },
      { id: 2, name: '工商银行信用卡 (**** 6666)' },
      { id: 3, name: '建设银行信用卡 (**** 9999)' }
    ],
    
    // 统计数据
    stats: {
      totalCount: 0,
      completedCount: 0,
      activeCount: 0,
      monthlyTotalAmount: '0',
      totalAmount: '0',
      paidAmount: '0',
      remainingAmount: '0'
    },

    // 日期选择器
    showDatePicker: false,
    dateOptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],

    // 信用卡选择器
    showCardPicker: false,



    // 导航栏相关数据
    statusBarHeight: 0,
    navigationBarHeight: 0
  },

  onLoad: async function (options) {
    this.billDataManager = getBillDataManager();
    await this.loadInstallments();
    this.calculateStats();
    this.getSystemInfo();
    this.loadCardOptions();
    console.log('onLoad完成后的installments数据:', this.data.installments);
  },

  onShow: async function () {
    await this.loadInstallments();
    this.calculateStats();
    this.loadCardOptions();
    
    // 设置自定义tabBar选中状态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1
      })
    }
  },

  onPullDownRefresh: async function () {
    await this.loadInstallments();
    this.calculateStats();
    wx.stopPullDownRefresh();
  },

  // 获取系统信息
  getSystemInfo: function() {
    const systemInfo = wx.getSystemInfoSync();
    
    const statusBarHeight = systemInfo.statusBarHeight;
    const navigationBarHeight = 32; // 固定为32px，与原生导航栏高度一致
    
    this.setData({
      statusBarHeight: statusBarHeight,
      navigationBarHeight: navigationBarHeight
    });
  },

  // 加载分期账单数据
  loadInstallments: async function() {
    try {
      const installments = await this.billDataManager.getBillList();
      return new Promise((resolve) => {
        this.setData({ installments }, () => {
          console.log('分期账单数据加载完成，共', installments.length, '条');
          resolve();
        });
      });
    } catch (error) {
      console.error('加载分期账单数据失败:', error);
      return new Promise((resolve) => {
        this.setData({ installments: [] }, resolve);
      });
    }
  },



  // 加载卡片选项
  loadCardOptions: async function() {
    try {
      const cardDataManager = getCardDataManager();
      const cardList = await cardDataManager.getCardList();
      
      // 格式化卡片选项（卡包中的卡片默认都是信用卡），包含还款日期信息
      const cardOptions = cardList.map(card => ({
        id: card.id,
        name: `${card.name} (**** ${card.cardNumber.slice(-4)})`,
        dueDate: card.dueDate // 添加还款日期信息
      }));
      
      this.setData({
        cardOptions: cardOptions
      });
      
      console.log('加载卡片选项成功:', cardOptions);
    } catch (error) {
      console.error('加载卡片选项失败:', error);
      wx.showToast({
        title: '加载卡片失败',
        icon: 'none'
      });
    }
  },



  // 计算统计数据
  calculateStats: function () {
    const installments = this.data.installments;
    
    // 1、分期总账单数：取当前该用户在分期页面中已创建的分期账单合计数量
    let totalCount = installments.length;
    
    // 2、已还清账单数：取当前该用户在分期页面中的分期账单的状态为已还清的账单数量合计（即已还分期数=分期笔数）
    let completedCount = 0;
    
    // 3、未还清账单数：取当前该用户在分期页面中的分期账单的状态为未还清的账单数量合计（即已还分期数小于分期笔数）
    let activeCount = 0;
    
    // 4、每期合计还款金额：取当前分期页面中所有状态为未还清的分期账单中的每期还款金额之和
    let monthlyTotalAmount = 0;
    
    // 5、累计账单总金额：取当前该用户在分期页面中已创建的分期账单合计账单总金额
    let totalBillAmount = 0;
    
    // 6、累计已还款金额：取当前该用户在分期页面中已创建的分期账单合计已还款金额
    let totalPaidAmount = 0;
    
    // 7、累计剩余还款金额：计算公式为=累计账单总金额-累计已还款金额
    let totalRemainingAmount = 0;

    installments.forEach(item => {
      const itemTotalAmount = parseFloat(item.totalAmount.replace(/,/g, ''));
      const itemPaidAmount = parseFloat(item.paidAmount.replace(/,/g, ''));
      const itemPaidCount = parseInt(item.paidCount) || 0;
      const itemTotalCount = parseInt(item.totalCount) || 0;
      const itemMonthlyPayment = parseFloat(item.monthlyPayment.replace(/,/g, ''));
      
      // 判断是否已还清：已还分期数 = 分期笔数
      if (itemPaidCount >= itemTotalCount) {
        completedCount++;
      } else {
        activeCount++;
        // 只有未还清的账单才计入每期合计还款金额
        monthlyTotalAmount += itemMonthlyPayment;
      }
      
      // 累计所有账单的总金额和已还款金额
      totalBillAmount += itemTotalAmount;
      totalPaidAmount += itemPaidAmount;
    });
    
    // 计算累计剩余还款金额
    totalRemainingAmount = totalBillAmount - totalPaidAmount;

    this.setData({
      'stats.totalCount': totalCount,
      'stats.completedCount': completedCount,
      'stats.activeCount': activeCount,
      'stats.monthlyTotalAmount': this.formatNumber(monthlyTotalAmount),
      'stats.totalAmount': this.formatNumber(totalBillAmount),
      'stats.paidAmount': this.formatNumber(totalPaidAmount),
      'stats.remainingAmount': this.formatNumber(totalRemainingAmount)
    });
  },

  // 格式化数字
  formatNumber: function (num) {
    return num.toLocaleString();
  },

  // 生成安全的唯一ID
  generateSecureId: function() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `bill_${timestamp}_${random}`;
  },

  // 保存账单数据的通用方法
  saveBillData: async function(installments) {
    try {
      await this.billDataManager.saveBillList(installments);
      console.log('[分期页面] 账单数据保存成功');
    } catch (error) {
      console.error('[分期页面] 账单数据保存失败:', error);
      wx.showToast({ title: '保存失败', icon: 'error' });
    }
  },

  // 显示统计弹窗
  showStatsPopup: function () {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    this.setData({ showStatsPopup: true });
  },

  // 隐藏统计弹窗
  hideStatsPopup: function () {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    this.setData({ showStatsPopup: false });
  },

  // 显示添加分期弹窗
  showAddInstallmentPopup: function () {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    this.resetFormData();
    
    // 设置默认选中首个卡片选项
    const defaultCardIndex = this.data.cardOptions.length > 0 ? 0 : -1;
    const updateData = { 
      showInstallmentPopup: true,
      editingInstallment: null,
      popupScrollTop: 0, // 重置滚动位置
      'formData.cardIndex': defaultCardIndex
    };
    
    // 如果有默认选中的信用卡，设置其还款日期
    if (defaultCardIndex >= 0 && this.data.cardOptions[defaultCardIndex] && this.data.cardOptions[defaultCardIndex].dueDate) {
      updateData['formData.paymentDate'] = this.data.cardOptions[defaultCardIndex].dueDate;
    }
    
    this.setData(updateData);
  },

  // 隐藏分期弹窗
  hideInstallmentPopup: function () {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    this.setData({ showInstallmentPopup: false });
  },

  // 阻止事件冒泡
  stopPropagation: function () {
    // 阻止事件冒泡
  },

  // 隐藏确认弹窗
  hideConfirmModal: function () {
    this.setData({ showConfirmPopup: false });
    
    // 重新显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      });
    }
  },

  // 确认操作
  confirmAction: function () {
    const { actionType, installmentIndex } = this.data.confirmData;
    
    if (actionType === 'pay') {
      this.executePayment(installmentIndex);
    } else if (actionType === 'cancel') {
      this.executeCancelPayment(installmentIndex);
    }
    
    this.hideConfirmModal();
  },

  // 执行还款操作
  executePayment: async function (index) {
    const installments = this.data.installments;
    const installment = installments[index];
    
    if (installment.paidCount < installment.totalCount) {
      installment.paidCount++;
      const monthlyAmount = parseFloat(installment.monthlyPayment.replace(/,/g, ''));
      const currentPaid = parseFloat(installment.paidAmount.replace(/,/g, ''));
      const newPaidAmount = currentPaid + monthlyAmount;
      const totalAmount = parseFloat(installment.totalAmount.replace(/,/g, ''));
      
      installment.paidAmount = this.formatNumber(newPaidAmount);
      installment.remainingAmount = this.formatNumber(totalAmount - newPaidAmount);
      installment.progress = Math.round((installment.paidCount / installment.totalCount) * 100);
      // 使用确认弹窗中选择的还款日期，并转换为系统格式
      const paymentDate = this.data.confirmData.paymentDate || this.formatDate(new Date());
      if (paymentDate.includes('-')) {
        const parts = paymentDate.split('-');
        if (parts.length === 3) {
          installment.lastPaymentDate = `${parts[0]}年${parts[1]}月${parts[2]}日`;
        } else {
          installment.lastPaymentDate = paymentDate;
        }
      } else {
        installment.lastPaymentDate = paymentDate;
      }
      
      if (installment.paidCount >= installment.totalCount) {
        installment.status = 'completed';
      }
      
      this.setData({ installments });
      
      // 使用BillDataManager保存数据
      await this.saveBillData(installments);
      
      // 添加还款记录到历史记录中
      try {
        await this.billDataManager.addPaymentRecord(installment.id, {
          amount: monthlyAmount,
          paymentDate: installment.lastPaymentDate,
          currentPeriod: installment.paidCount,
          totalPeriods: installment.totalCount,
          cardName: installment.cardName,
          cardNumber: installment.cardNumber || ''
        });
        console.log('还款记录已添加到历史记录');
      } catch (error) {
        console.error('添加还款记录失败:', error);
      }
      
      this.calculateStats();
      
      wx.showToast({
        title: '还款成功',
        icon: 'success'
      });
    }
  },

  // 执行撤销还款操作
  executeCancelPayment: async function (index) {
    const installments = this.data.installments;
    const installment = installments[index];
    
    if (installment.paidCount > 0) {
      installment.paidCount--;
      const monthlyAmount = parseFloat(installment.monthlyPayment.replace(/,/g, ''));
      const currentPaid = parseFloat(installment.paidAmount.replace(/,/g, ''));
      const newPaidAmount = currentPaid - monthlyAmount;
      const totalAmount = parseFloat(installment.totalAmount.replace(/,/g, ''));
      
      installment.paidAmount = this.formatNumber(Math.max(0, newPaidAmount));
      installment.remainingAmount = this.formatNumber(totalAmount - Math.max(0, newPaidAmount));
      installment.progress = Math.round((installment.paidCount / installment.totalCount) * 100);
      installment.status = 'active';
      
      // 清除最后还款日期记录
      delete installment.lastPaymentDate;
      
      this.setData({ installments });
      
      // 使用BillDataManager保存数据
      await this.saveBillData(installments);
      
      // 删除对应的还款记录
      try {
        const result = await this.billDataManager.removeLastPaymentRecord(installment.id);
        if (result.success) {
          console.log('还款记录已从历史记录中删除:', result.removedRecord);
        } else {
          console.warn('删除还款记录警告:', result.error);
        }
      } catch (error) {
        console.error('删除还款记录失败:', error);
      }
      
      this.calculateStats();
      
      wx.showToast({
        title: '撤销成功',
        icon: 'success'
      });
    }
  },

  // 重置表单数据
  resetFormData: function () {
    this.setData({
      formData: {
        cardIndex: -1,
        totalAmount: '',
        totalCount: '',
        monthlyPayment: '',
        paymentDate: '',
        paidCount: '0',
        remainingCount: '',
        paidAmount: '0',
        remainingAmount: '',
        lastPaymentDate: ''  // 默认为空，允许用户选择或不选择
      }
    });
    
    // 触发剩余金额计算
    this.calculateRemainingAmount();
  },

  // 编辑分期
  editInstallment: function (e) {
    console.log('editInstallment 被调用', e);
    console.log('dataset:', e.currentTarget.dataset);
    const id = e.currentTarget.dataset.id;
    console.log('获取的ID:', id);
    
    if (!id) {
      console.error('未找到data-id属性');
      wx.showToast({ title: '数据错误，请重试', icon: 'none' });
      return;
    }
    
    // 兼容旧的数字ID和新的字符串ID
    const installment = this.data.installments.find(item => {
      // 严格比较，支持字符串和数字ID
      return item.id == id || item.id === parseInt(id) || item.id === id.toString();
    });
    console.log('找到的分期账单:', installment);
    console.log('当前所有分期账单:', this.data.installments);
    
    if (installment) {
      // 隐藏自定义tabBar
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().setData({
          hidden: true
        })
      }
      
      // 找到对应的卡片索引
      const cardIndex = this.data.cardOptions.findIndex(card => 
        installment.cardName.includes(card.name.split(' ')[0])
      );
      
      this.setData({
        editingInstallment: installment,
        showInstallmentPopup: true,
        popupScrollTop: 0, // 重置滚动位置
        formData: {
          cardIndex: cardIndex >= 0 ? cardIndex : -1,
          totalAmount: installment.totalAmount.replace(/,/g, ''),
          totalCount: installment.totalCount.toString(),
          monthlyPayment: installment.monthlyPayment.replace(/,/g, ''),
          paymentDate: installment.paymentDate.toString(),
          paidCount: installment.paidCount.toString(),
          remainingCount: (installment.totalCount - installment.paidCount).toString(),
          paidAmount: installment.paidAmount.replace(/,/g, ''),
          remainingAmount: installment.remainingAmount.replace(/,/g, ''),
          lastPaymentDate: installment.lastPaymentDate ? installment.lastPaymentDate.replace(/年|月|日/g, match => {
            if (match === '年') return '-';
            if (match === '月') return '-';
            return '';
          }) : ''
        }
      });
    }
  },

  // 删除分期
  deleteInstallment: function (e) {
    const id = e.currentTarget.dataset.id;
    const index = e.currentTarget.dataset.index;
    
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个分期账单吗？',
      success: async (res) => {
        if (res.confirm) {
          const installments = this.data.installments;
          installments.splice(index, 1);
          this.setData({ installments });
          
          // 使用BillDataManager保存数据
          await this.saveBillData(installments);
          this.calculateStats();
          
          wx.showToast({
            title: '删除成功',
            icon: 'success'
          });
        }
      }
    });
  },

  // 按期还款
  payInstallment: function (e) {
    const id = e.currentTarget.dataset.id;
    const index = parseInt(e.currentTarget.dataset.index);
    const installment = this.data.installments[index];
    
    if (installment.paidCount >= installment.totalCount) {
      wx.showToast({
        title: '已全部还清',
        icon: 'none'
      });
      return;
    }
    
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      });
    }
    
    this.setData({
      showConfirmPopup: true,
      confirmData: {
        actionType: 'pay',
        installmentId: id,
        installmentIndex: index,
        title: '确认还款',
        message: '确定要进行本期还款吗？',
        icon: 'icon-credit-card',
        beforeCount: installment.paidCount,
        afterCount: installment.paidCount + 1,
        paymentDate: installment.lastPaymentDate ? (() => {
          // 如果已有最近还款日期，转换为YYYY-MM-DD格式
          const lastDate = installment.lastPaymentDate.replace(/年|月|日/g, match => {
            if (match === '年') return '-';
            if (match === '月') return '-';
            return '';
          });
          return lastDate;
        })() : this.formatDate(new Date())
      }
    });
  },

  // 撤销还款
  cancelPayment: function (e) {
    const id = e.currentTarget.dataset.id;
    const index = parseInt(e.currentTarget.dataset.index);
    const installment = this.data.installments[index];
    
    // 检查是否存在确认还款的操作记录
    if (!installment.lastPaymentDate || installment.lastPaymentDate === '') {
      wx.showToast({
        title: '无可撤销的还款',
        icon: 'none'
      });
      return;
    }
    
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      });
    }
    
    this.setData({
      showConfirmPopup: true,
      confirmData: {
        actionType: 'cancel',
        installmentId: id,
        installmentIndex: index,
        title: '确认撤销',
        message: '确定要撤销上次还款吗？',
        icon: 'icon-undo',
        beforeCount: installment.paidCount,
        afterCount: installment.paidCount - 1
      }
    });
  },

  // 格式化日期
  formatDate: function (date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${year}年${month}月${day}日`;
  },

  // 表单输入处理


  onInputTotalAmount: function (e) {
    let value = e.detail.value;
    
    // 只允许输入数字和小数点
    value = value.replace(/[^\d.]/g, '');
    
    // 只允许一个小数点
    const dotCount = (value.match(/\./g) || []).length;
    if (dotCount > 1) {
      value = value.substring(0, value.lastIndexOf('.'));
    }
    
    // 限制小数点后最多2位
    if (value.includes('.')) {
      const parts = value.split('.');
      if (parts[1] && parts[1].length > 2) {
        value = parts[0] + '.' + parts[1].substring(0, 2);
      }
    }
    
    // 限制上限为99999999.99
    const numValue = parseFloat(value) || 0;
    if (numValue > 99999999.99) {
      value = '99999999.99';
      wx.showToast({
        title: '金额不能超过99999999.99',
        icon: 'none'
      });
    }
    
    this.setData({
      'formData.totalAmount': value
    });
    this.calculateInstallment();
    this.calculateRemainingAmount();
  },

  onInputTotalCount: function (e) {
    let value = e.detail.value;
    
    // 只允许输入数字
    value = value.replace(/[^\d]/g, '');
    
    // 限制上限为999
    if (value && parseInt(value) > 999) {
      value = '999';
      wx.showToast({
        title: '分期笔数不能超过999',
        icon: 'none'
      });
    }
    
    this.setData({
      'formData.totalCount': value
    });
    this.calculateInstallment();
    this.calculateRemaining();
  },

  onInputMonthlyPayment: function (e) {
    let value = e.detail.value;
    
    // 只允许输入数字和小数点
    value = value.replace(/[^\d.]/g, '');
    
    // 确保只有一个小数点
    const parts = value.split('.');
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('');
    }
    
    // 限制小数点后最多2位
    if (parts[1] && parts[1].length > 2) {
      value = parts[0] + '.' + parts[1].substring(0, 2);
    }
    
    // 验证范围1-99999999
    const numValue = parseFloat(value);
    if (value && numValue > 99999999) {
      value = '99999999';
      wx.showToast({
        title: '每期还款不能超过99999999',
        icon: 'none'
      });
    } else if (value && numValue < 1 && numValue !== 0) {
      value = '1';
      wx.showToast({
        title: '每期还款不能小于1',
        icon: 'none'
      });
    }
    
    this.setData({
      'formData.monthlyPayment': value
    });
  },

  // 显示日期选择弹窗
  showDatePicker: function () {
    this.setData({
      showDatePicker: true
    })
  },

  // 隐藏日期选择弹窗
  hideDatePicker: function () {
    this.setData({
      showDatePicker: false
    })
  },

  // 选择日期
  selectDate: function (e) {
    const date = e.currentTarget.dataset.date
    this.setData({
      'formData.paymentDate': date,
      showDatePicker: false
    })
  },

  // 显示信用卡选择弹窗
  showCardPicker: function () {
    this.setData({
      showCardPicker: true
    })
  },

  // 隐藏信用卡选择弹窗
  hideCardPicker: function () {
    this.setData({
      showCardPicker: false
    })
  },

  // 选择信用卡
  selectCard: function (e) {
    const index = e.currentTarget.dataset.index
    const selectedCard = this.data.cardOptions[index]
    
    // 设置选中的信用卡索引和默认还款日期
    const updateData = {
      'formData.cardIndex': index,
      showCardPicker: false
    }
    
    // 如果选中的信用卡有还款日期，则设置为默认还款日期
    if (selectedCard && selectedCard.dueDate) {
      updateData['formData.paymentDate'] = selectedCard.dueDate
    }
    
    this.setData(updateData)
  },



  // 选择最后还款日期
  selectLastPaymentDate: function (e) {
    const selectedDate = e.detail.value;
    this.setData({
      'formData.lastPaymentDate': selectedDate
    });
  },

  // 清空最后还款日期
  clearLastPaymentDate: function () {
    this.setData({
      'formData.lastPaymentDate': ''
    });
  },

  // 选择确认弹窗中的还款日期
  selectConfirmPaymentDate: function (e) {
    this.setData({
      'confirmData.paymentDate': e.detail.value
    });
  },

  onInputPaidCount: function (e) {
    let value = e.detail.value;
    
    // 只允许输入数字
    value = value.replace(/[^\d]/g, '');
    
    // 限制范围0-999
    if (value && parseInt(value) > 999) {
      value = '999';
      wx.showToast({
        title: '已还分期数不能超过999',
        icon: 'none'
      });
    }
    
    // 自动计算已还款金额：已还分期数 * 每期还款金额
    const paidCount = parseInt(value) || 0;
    const monthlyPayment = parseFloat(this.data.formData.monthlyPayment) || 0;
    const calculatedPaidAmount = paidCount * monthlyPayment;
    
    this.setData({
      'formData.paidCount': value,
      'formData.paidAmount': calculatedPaidAmount > 0 ? calculatedPaidAmount.toFixed(2) : '0'
    });
    this.calculateRemaining();
    this.calculateRemainingAmount();
  },

  onInputPaidAmount: function (e) {
    let value = e.detail.value;
    
    // 只允许输入数字和小数点
    value = value.replace(/[^\d.]/g, '');
    
    // 确保只有一个小数点
    const parts = value.split('.');
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('');
    }
    
    // 限制小数点后最多2位
    if (parts[1] && parts[1].length > 2) {
      value = parts[0] + '.' + parts[1].substring(0, 2);
    }
    
    // 验证范围0-99999999
    const numValue = parseFloat(value);
    if (value && numValue > 99999999) {
      value = '99999999';
      wx.showToast({
        title: '已还款金额不能超过99999999',
        icon: 'none'
      });
    }
    
    this.setData({
      'formData.paidAmount': value
    });
    this.calculateRemainingAmount();
  },



  // 计算分期
  calculateInstallment: function () {
    const totalAmount = parseFloat(this.data.formData.totalAmount) || 0;
    const totalCount = parseInt(this.data.formData.totalCount) || 0;
    
    if (totalAmount > 0 && totalCount > 0) {
      const monthlyPayment = (totalAmount / totalCount).toFixed(2);
      this.setData({
        'formData.monthlyPayment': monthlyPayment
      });
    }
  },

  // 计算剩余分期数
  calculateRemaining: function () {
    const totalCount = parseInt(this.data.formData.totalCount) || 0;
    const paidCount = parseInt(this.data.formData.paidCount) || 0;
    const remainingCount = Math.max(0, totalCount - paidCount);
    
    this.setData({
      'formData.remainingCount': remainingCount.toString()
    });
  },

  // 计算剩余还款金额
  calculateRemainingAmount: function () {
    const totalAmount = parseFloat(this.data.formData.totalAmount) || 0;
    const paidAmount = parseFloat(this.data.formData.paidAmount) || 0;
    const remainingAmount = Math.max(0, totalAmount - paidAmount);
    
    this.setData({
      'formData.remainingAmount': remainingAmount.toString()
    });
  },

  // 保存分期
  saveInstallment: async function () {
    const formData = this.data.formData;
    
    // 表单验证
    if (formData.cardIndex < 0) {
      wx.showToast({ title: '请选择卡片', icon: 'none' });
      return;
    }
    
    if (!formData.totalAmount) {
      wx.showToast({ title: '请输入账单总金额', icon: 'none' });
      return;
    }
    
    if (!formData.totalCount) {
      wx.showToast({ title: '请输入分期笔数', icon: 'none' });
      return;
    }
    
    if (!formData.monthlyPayment) {
      wx.showToast({ title: '请输入每期还款金额', icon: 'none' });
      return;
    }
    
    const installments = this.data.installments;
    const selectedCard = this.data.cardOptions[formData.cardIndex];
    const totalAmount = parseFloat(formData.totalAmount);
    const paidAmount = parseFloat(formData.paidAmount) || 0;
    const totalCount = parseInt(formData.totalCount);
    const paidCount = parseInt(formData.paidCount) || 0;
    
    const installmentData = {
      cardId: selectedCard.id, // 添加cardId字段
      cardName: selectedCard.name.split(' (')[0],
      cardNumber: selectedCard.name.match(/\((.*)\)/)[1],
      totalAmount: this.formatNumber(totalAmount),
      totalCount: totalCount,
      paidCount: paidCount,
      monthlyPayment: this.formatNumber(parseFloat(formData.monthlyPayment)),
      paymentDate: parseInt(formData.paymentDate),
      paidAmount: this.formatNumber(paidAmount),
      remainingAmount: this.formatNumber(totalAmount - paidAmount),
      lastPaymentDate: formData.lastPaymentDate ? (() => {
        const parts = formData.lastPaymentDate.split('-');
        if (parts.length === 3) {
          return `${parts[0]}年${parts[1]}月${parts[2]}日`;
        }
        return formData.lastPaymentDate;
      })() : '',
      progress: Math.round((paidCount / totalCount) * 100),
      status: paidCount >= totalCount ? 'completed' : 'active'
    };
    
    if (this.data.editingInstallment) {
      // 编辑模式
      const index = installments.findIndex(item => item.id === this.data.editingInstallment.id);
      if (index >= 0) {
        installments[index] = { ...installments[index], ...installmentData };
      }
    } else {
      // 添加模式 - 使用安全的ID生成
      const newId = this.generateSecureId();
      installments.push({ id: newId, ...installmentData });
    }
    
    this.setData({ installments });
    
    // 使用BillDataManager保存数据
    try {
      await this.billDataManager.saveBillList(installments);
      console.log('[分期页面] 账单数据保存成功');
    } catch (error) {
      console.error('[分期页面] 账单数据保存失败:', error);
      wx.showToast({ title: '保存失败', icon: 'error' });
      return;
    }
    
    this.calculateStats();
    this.hideInstallmentPopup();
    
    wx.showToast({
      title: this.data.editingInstallment ? '编辑成功' : '添加成功',
      icon: 'success'
    });
  },

  // 分享给朋友
  onShareAppMessage: function() {
    return {
      title: '我的"负债清零"计划进行中！',
      path: '/pages/installments/installments',
      imageUrl: '/images/share.png'
    }
  },

  // 分享到朋友圈
  onShareTimeline: function() {
    return {
      title: '我的"负债清零"计划进行中！',
      query: '',
      imageUrl: '/images/share.png'
    }
  }

});