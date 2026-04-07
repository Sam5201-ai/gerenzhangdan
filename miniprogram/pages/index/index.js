// index.js
const app = getApp()
const { getCardDataManager } = require('../../utils/CardDataManager.js')
const { getUserManager } = require('../../utils/UserManager.js')

Page({
  data: {
    // 状态栏高度
    statusBarHeight: 0,
    
    // 信用卡列表
    cardList: [],
    
    // 弹窗相关
    showCardPopup: false,
    popupTitle: '添加信用卡',
    editingCardId: null,
    
    // 表单数据
    formData: {
      name: '',
      cardNumber: '',
      limit: '',
      dueDate: ''
    },
    
    // 样式选项
    styleOptions: ['blue', 'green', 'purple', 'orange', 'red', 'pink'],
    selectedStyle: 'blue',
    
    // 还款提醒
    reminderEnabled: false,
    reminderDaysOptions: [1, 3, 5, 7],
    selectedReminderDays: 3,
    

    
    // 同步状态
    isSyncing: false,
    
    // 用户信息
    userInfo: null,
    isLoggedIn: false,
    
    // 日期选择弹窗
    showDatePicker: false,
    dateOptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
    
    // 本地存储提示弹窗
    showStorageTipPopup: false
  },

  onLoad: async function(options) {
    // 页面加载时的初始化
    console.log('卡包页面加载完成')
    
    // 获取状态栏高度
    const systemInfo = wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: systemInfo.statusBarHeight
    })
    
    // 初始化管理器
    this.cardDataManager = getCardDataManager()
    this.userManager = getUserManager()
    
    // 确保弹窗初始状态为隐藏
    this.setData({
      showCardPopup: false
    })
    
    // 初始化用户信息
    await this.initUserInfo()
    
    // 加载卡片数据（首次加载尝试使用缓存）
    await this.loadCardList({ showLoading: false, useCache: false }) // 首次优先拉云端，避免清缓存后空白
    
    // 重要：启动阶段不要自动“静默更新”。
    // 该逻辑在数据量较大或并发触发时容易导致 Service 线程被占用，从而触发开发者工具的 Error: timeout。
    // 如需开启，可在用户手动触发“同步/刷新”时调用 checkAndUpdateCardList。
    
    // 检查是否首次进入，显示本地存储提示
    this.checkFirstTimeEntry()
  },
  
  // 初始化用户信息
  async initUserInfo() {
    try {
      // 初始化用户管理器
      await this.userManager.init()
      
      const userInfo = this.userManager.getUserInfo()
      
      this.setData({
        userInfo: userInfo,
        isLoggedIn: !!userInfo
      })
      
      console.log('用户信息已初始化')
      
    } catch (error) {
      console.error('初始化用户信息失败', error)
      
      this.setData({
        userInfo: null,
        isLoggedIn: false
      })
    }
  },
  
  // 加载卡片列表
  async loadCardList(options = {}) {
    const { showLoading = true, useCache = true } = options
    
    try {
      if (showLoading) {
        wx.showLoading({ title: '加载中...' })
      }
      
      const cardList = await this.cardDataManager.getCardList({
        useCache: useCache, // 可配置是否使用缓存
        maxAge: 30 * 60 * 1000 // 30分钟缓存有效期
      })

      // 只读取一次账单列表（避免每张卡都去读存储，数据多时会导致 Service 线程超时）
      const { getBillDataManager } = require('../../utils/BillDataManager.js')
      const billDataManager = getBillDataManager()
      const billList = await billDataManager.getBillList({ useCache: true, maxAge: 30 * 60 * 1000 })
      
      // 为每个卡片添加隐匿后的卡号和分期欠款
      const processedCardList = await Promise.all(cardList.map(async (card) => {
        const installmentDebt = this.calculateInstallmentDebtFromBills(card, billList)
        console.log(`卡片 ${card.name} 处理后的分期欠款:`, installmentDebt)
        return {
        ...card,
          maskedCardNumber: this.maskCardNumber(card.cardNumber),
          installmentDebt: installmentDebt
        }
      }))
      
      console.log('处理后的卡片列表:', processedCardList.map(card => ({
        name: card.name,
        installmentDebt: card.installmentDebt
      })))
      
      this.setData({
        cardList: processedCardList
      })
      
      console.log('setData后的cardList:', this.data.cardList.map(card => ({
        name: card.name,
        installmentDebt: card.installmentDebt
      })))
      
      
      console.log(`成功加载${cardList.length}张卡片`)
      
    } catch (error) {
      console.error('加载卡片列表失败', error)
      if (showLoading) {
        wx.showToast({
          title: '加载失败',
          icon: 'error'
        })
      }
    } finally {
      if (showLoading) {
        wx.hideLoading()
      }
    }
  },
  
  // 后台检查并更新卡片列表（静默更新）
  async checkAndUpdateCardList() {
    // 防重入：避免 onLoad/onShow 等多处触发造成并发执行
    if (this._isCheckingAndUpdating) {
      return
    }
    this._isCheckingAndUpdating = true

    try {
      // 数据为空时不做静默更新（减少启动期开销）
      if (!this.data || !Array.isArray(this.data.cardList) || this.data.cardList.length === 0) {
        return
      }

      // 不显示加载状态，静默获取最新数据
      const cardList = await this.cardDataManager.getCardList({
        useCache: false, // 强制从存储获取最新数据
        maxAge: 0 // 不使用缓存
      })

      // 静默更新也只读取一次账单列表
      const { getBillDataManager } = require('../../utils/BillDataManager.js')
      const billDataManager = getBillDataManager()
      const billList = await billDataManager.getBillList({ useCache: false, maxAge: 0 })
      
      // 为每个卡片添加隐匿后的卡号和分期欠款
      const processedCardList = await Promise.all(cardList.map(async (card) => {
        const installmentDebt = this.calculateInstallmentDebtFromBills(card, billList)
        return {
        ...card,
          maskedCardNumber: this.maskCardNumber(card.cardNumber),
          installmentDebt: installmentDebt
        }
      }))
      
      console.log('静默更新 - 处理后的分期欠款:', processedCardList.map(card => ({
        name: card.name,
        installmentDebt: card.installmentDebt
      })))
      
      // 比较数据是否有变化
      const currentCardList = this.data.cardList
      // 避免 JSON.stringify 大对象造成卡顿：只做轻量比较
      const hasChanges =
        currentCardList.length !== processedCardList.length ||
        currentCardList.some((c, i) => (c?.id || '') !== (processedCardList[i]?.id || '') || (c?.updatedAt || 0) !== (processedCardList[i]?.updatedAt || 0))
      
      if (hasChanges) {
        // 静默更新数据
        this.setData({
          cardList: processedCardList
        })
        console.log(`静默更新了${cardList.length}张卡片`)
      }
      
    } catch (error) {
      console.error('后台更新卡片列表失败', error)
      // 静默失败，不显示错误提示
    } finally {
      this._isCheckingAndUpdating = false
    }
  },
  
  onShow: function() {
    // 设置自定义tabBar选中状态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 0
      })
    }
    
    // 只在数据为空时才重新加载，否则使用缓存
    if (this.data.cardList.length === 0) {
      this.initUserInfo() // 更新用户信息
      this.loadCardList() // 加载卡片数据
    } else {
      // 静默更新用户信息，不显示加载状态
      this.initUserInfo()
      // 进入页面不再自动触发静默更新（避免 Error: timeout）
    }
  },
  
  onHide: function() {
    // 页面隐藏时保存数据（由数据管理器自动处理）
  },
  
  onUnload: function() {
    // 页面卸载时清理资源
    if (this.cardDataManager) {
      // 注意：不要销毁单例管理器，其他页面可能还在使用
    }
  },

  // 显示添加卡片弹窗
  showAddCardPopup() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    // 设置显示状态
    this.setData({
      showCardPopup: true,
      popupTitle: '添加信用卡',
      editingCardId: null,
      formData: {
        name: '',
        cardNumber: '',
        limit: '',
        dueDate: ''
      },
      selectedStyle: 'blue',
      reminderEnabled: false,
      selectedReminderDays: 3
    })
  },

  // 编辑卡片
  editCard(e) {
    const cardId = e.currentTarget.dataset.id
    const card = this.data.cardList.find(item => item.id === cardId)
    
    if (card) {
      // 隐藏自定义tabBar
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().setData({
          hidden: true
        })
      }
      
      this.setData({
        showCardPopup: true,
        popupTitle: '编辑信用卡',
        editingCardId: cardId,
        formData: {
          name: card.name,
          cardNumber: card.cardNumber,
          limit: card.limit,
          dueDate: card.dueDate
        },
        selectedStyle: card.style,
        reminderEnabled: card.reminderEnabled || false,
        selectedReminderDays: card.reminderDays || 3
      })
    }
  },

  // 删除卡片
  deleteCard(e) {
    const cardId = e.currentTarget.dataset.id
    
    // 查找卡片信息用于显示
    const card = this.data.cardList.find(item => item.id == cardId)
    const cardName = card ? card.name : '未知卡片'
    
    wx.showModal({
      title: '确认删除',
      content: `确定要删除「${cardName}」吗？`,
      success: async (res) => {
        if (res.confirm) {
          try {
            await this.cardDataManager.deleteCard(cardId)
            
            // 更新本地列表
            await this.loadCardList()
            
            wx.showToast({
              title: '删除成功',
              icon: 'success'
            })
          } catch (error) {
            console.error('删除卡片失败', error)
            wx.showToast({
              title: '删除失败',
              icon: 'error'
            })
          }
        }
      }
    })
  },

  // 隐藏弹窗
  hideCardPopup() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    // 直接隐藏弹窗，CSS会处理动画
      this.setData({
        showCardPopup: false
      })
  },

  // 阻止事件冒泡
  stopPropagation() {
    // 空函数，用于阻止事件冒泡
  },

  // 表单输入事件
  onInputName(e) {
    this.setData({
      'formData.name': e.detail.value
    })
  },

  onInputCardNumber(e) {
    this.setData({
      'formData.cardNumber': e.detail.value
    })
  },

  onInputLimit(e) {
    this.setData({
      'formData.limit': e.detail.value
    })
  },

  onInputDueDate(e) {
    this.setData({
      'formData.dueDate': e.detail.value
    })
  },

  // 显示日期选择弹窗
  showDatePicker() {
    this.setData({
      showDatePicker: true
    })
  },

  // 隐藏日期选择弹窗
  hideDatePicker() {
    this.setData({
      showDatePicker: false
    })
  },

  // 选择日期
  selectDate(e) {
    const date = e.currentTarget.dataset.date
    this.setData({
      'formData.dueDate': date,
      showDatePicker: false
    })
  },

  // 选择卡片样式
  selectCardStyle(e) {
    const style = e.currentTarget.dataset.style
    this.setData({
      selectedStyle: style
    })
  },

  // 切换还款提醒
  toggleReminder() {
    this.setData({
      reminderEnabled: !this.data.reminderEnabled
    })
  },

  // 选择提醒天数
  selectReminderDays(e) {
    const days = e.currentTarget.dataset.days
    this.setData({
      selectedReminderDays: days
    })
  },

  // 保存卡片
  async saveCard() {
    const { formData, selectedStyle, reminderEnabled, selectedReminderDays, editingCardId } = this.data
    
    try {
      // 构建卡片数据
      const cardData = {
        name: formData.name,
        cardNumber: formData.cardNumber,
        limit: formData.limit,
        dueDate: formData.dueDate,
        style: selectedStyle,
        reminderEnabled: reminderEnabled,
        reminderDays: selectedReminderDays
      }
      
      // 保存卡片数据
      if (editingCardId) {
        await this.cardDataManager.updateCard(editingCardId, cardData)
      } else {
        await this.cardDataManager.addCard(cardData)
      }
      
      // 立即关闭弹窗（提升响应速度）
      this.hideCardPopup()
      
      // 显示成功提示
      wx.showToast({
        title: editingCardId ? '修改成功' : '添加成功',
        icon: 'success',
        duration: 500
      })
      
      // 后台异步刷新列表（不阻塞UI）
      setTimeout(() => {
        this.loadCardList({ showLoading: false, useCache: false })
      }, 100)
      
    } catch (error) {
      console.error('[卡包页面] 保存卡片失败:', error)
      
      // 显示具体错误信息
      wx.showToast({
        title: error.message || '保存失败',
        icon: 'none',
        duration: 2000
      })
    }
  },
  
  
  // 导出数据
  async exportData() {
    try {
      await this.cardDataManager.exportCards()
    } catch (error) {
      console.error('导出数据失败', error)
      wx.showToast({
        title: '导出失败',
        icon: 'error'
      })
    }
  },
  
  // 导入数据
  async importData() {
    try {
      const importCount = await this.cardDataManager.importCards()
      if (importCount > 0) {
        await this.loadCardList()
      }
    } catch (error) {
      console.error('导入数据失败', error)
    }
  },
  
  // 获取统计信息
  async getStatistics() {
    try {
      const stats = await this.cardDataManager.getStatistics()
      console.log('统计信息:', stats)
      return stats
    } catch (error) {
      console.error('获取统计信息失败', error)
      return null
    }
  },
  
  // 计算指定卡片的分期欠款总金额（传入账单列表，避免重复读存储）
  calculateInstallmentDebtFromBills(card, billList) {
    try {
      if (!billList || billList.length === 0) {
        return '0'
      }

      // 通过cardId匹配分期账单
      const cardBills = billList.filter(bill => {
        // 优先使用cardId匹配（新数据）
        if (bill.cardId && card.id) {
          return bill.cardId === card.id
        }

        // 兼容旧数据：如果没有cardId，则使用名称匹配
        if (!bill.cardId && bill.cardName && card.name) {
          const billCardName = bill.cardName.toLowerCase()
          const cardName = card.name.toLowerCase()

          // 银行关键词匹配
          const keywords = ['招商', '工商', '建设', '农业', '中国', '交通', '民生', '光大', '华夏', '平安', '兴业', '浦发', '中信', '广发']
          for (const keyword of keywords) {
            if (billCardName.includes(keyword) && cardName.includes(keyword)) {
              return true
            }
          }
        }

        return false
      })

      // 计算总的剩余还款金额
      let totalDebt = 0
      cardBills.forEach(bill => {
        const remainingAmount = parseFloat((bill.remainingAmount ?? '').toString().replace(/,/g, '')) || 0
        totalDebt += remainingAmount
      })

      console.log(`卡片 ${card.name} 分期欠款: ¥${totalDebt.toLocaleString()}`)
      return totalDebt > 0 ? totalDebt.toLocaleString() : '0'
    } catch (error) {
      console.error('计算分期欠款失败:', error)
      return '0'
    }
  },
  
  // 卡号隐匿处理
  maskCardNumber(cardNumber) {
    if (!cardNumber || cardNumber.length < 4) {
      return cardNumber
    }
    // 只显示后4位，前面用星号替代
    const lastFour = cardNumber.slice(-4)
    const maskedPart = '*'.repeat(Math.max(0, cardNumber.length - 4))
    return maskedPart + lastFour
  },

  // 注意：本文件上方已实现 onShow，这里不要重复定义，否则会覆盖并导致额外的强制刷新与潜在超时

  // 分享给朋友
  onShareAppMessage: function() {
    return {
      title: '我的"负债清零"计划进行中！',
      path: '/pages/index/index',
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
  },

  // 检查是否首次进入
  checkFirstTimeEntry: function() {
    try {
      const hasShownStorageTip = wx.getStorageSync('hasShownStorageTip')
      if (!hasShownStorageTip) {
        // 首次进入，延迟500ms显示提示，让页面先渲染完成
        setTimeout(() => {
          this.showStorageTipPopup()
          // 标记已显示过
          wx.setStorageSync('hasShownStorageTip', true)
        }, 500)
      }
    } catch (error) {
      console.error('检查首次进入状态失败:', error)
    }
  },

  // 显示本地存储提示弹窗
  showStorageTipPopup: function() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    this.setData({
      showStorageTipPopup: true
    })
  },

  // 隐藏本地存储提示弹窗
  hideStorageTipPopup: function() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.setData({
      showStorageTipPopup: false
    })
  }
})
