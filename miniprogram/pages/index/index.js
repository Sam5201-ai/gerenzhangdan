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
    popupAnimation: {},
    
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
    dateOptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
  },

  onLoad: function(options) {
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
    this.initUserInfo()
    
    // 加载卡片数据（首次加载尝试使用缓存）
    this.loadCardList({ showLoading: false }) // 首次加载不显示loading，优先使用缓存
    
    // 延迟进行后台数据检查更新
    setTimeout(() => {
      this.checkAndUpdateCardList()
    }, 500)
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
    const { showLoading = true } = options
    
    try {
      if (showLoading) {
        wx.showLoading({ title: '加载中...' })
      }
      
      const cardList = await this.cardDataManager.getCardList({
        useCache: true, // 优先使用缓存
        maxAge: 30 * 60 * 1000 // 30分钟缓存有效期
      })
      
      // 为每个卡片添加隐匿后的卡号
      const processedCardList = cardList.map(card => ({
        ...card,
        maskedCardNumber: this.maskCardNumber(card.cardNumber)
      }))
      
      this.setData({
        cardList: processedCardList
      })
      
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
    try {
      // 不显示加载状态，静默获取最新数据
      const cardList = await this.cardDataManager.getCardList({
        useCache: false, // 强制从存储获取最新数据
        maxAge: 0 // 不使用缓存
      })
      
      // 为每个卡片添加隐匿后的卡号
      const processedCardList = cardList.map(card => ({
        ...card,
        maskedCardNumber: this.maskCardNumber(card.cardNumber)
      }))
      
      // 比较数据是否有变化
      const currentCardList = this.data.cardList
      const hasChanges = JSON.stringify(currentCardList) !== JSON.stringify(processedCardList)
      
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
      // 后台检查是否有新数据，如果有则静默更新
      this.checkAndUpdateCardList()
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
    
    // 创建动画实例
    const animation = wx.createAnimation({
      duration: 300,
      timingFunction: 'ease',
      delay: 0
    })
    
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
    
    // 延迟执行动画
    setTimeout(() => {
      animation.translateY(0).opacity(1).step()
      this.setData({
        popupAnimation: animation.export()
      })
    }, 50)
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
      
      // 创建动画实例
      const animation = wx.createAnimation({
        duration: 300,
        timingFunction: 'ease',
        delay: 0
      })
      
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
      
      // 延迟执行动画
      setTimeout(() => {
        animation.translateY(0).opacity(1).step()
        this.setData({
          popupAnimation: animation.export()
        })
      }, 50)
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
    
    // 创建关闭动画
    const animation = wx.createAnimation({
      duration: 300,
      timingFunction: 'ease',
      delay: 0
    })
    
    // 执行关闭动画
    animation.translateY('100%').opacity(0).step()
    this.setData({
      popupAnimation: animation.export()
    })
    
    // 动画结束后隐藏弹窗
    setTimeout(() => {
      this.setData({
        showCardPopup: false
      })
    }, 300)
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
      console.log('[卡包页面] 开始保存卡片')
      
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
      
      console.log('[卡包页面] 卡片数据:', cardData)
      
      if (editingCardId) {
        // 编辑模式
        console.log('[卡包页面] 执行编辑操作')
        await this.cardDataManager.updateCard(editingCardId, cardData)
      } else {
        // 添加模式
        console.log('[卡包页面] 执行添加操作')
        const result = await this.cardDataManager.addCard(cardData)
        console.log('[卡包页面] 添加结果:', result)
      }
      
      console.log('[卡包页面] 卡片保存完成，开始更新列表')
      
      // 更新本地列表（不显示loading，避免覆盖toast）
      await this.loadCardList({ showLoading: false })
      
      // 显示成功提示
      wx.showToast({
        title: editingCardId ? '修改成功' : '添加成功',
        icon: 'success'
      })
      
      // 显示成功提示后关闭弹窗
      setTimeout(() => {
        this.hideCardPopup()
      }, 1000)
      
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
  
  // 卡号隐匿处理
  maskCardNumber(cardNumber) {
    if (!cardNumber || cardNumber.length < 4) {
      return cardNumber
    }
    // 只显示后4位，前面用星号替代
    const lastFour = cardNumber.slice(-4)
    const maskedPart = '*'.repeat(Math.max(0, cardNumber.length - 4))
    return maskedPart + lastFour
  }
})
