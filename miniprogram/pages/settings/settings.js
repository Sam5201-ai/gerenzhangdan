// pages/settings/settings.js
const { getUserManager } = require('../../utils/UserManager')
const { getCardDataManager } = require('../../utils/CardDataManager')
const { getBillDataManager } = require('../../utils/BillDataManager')

Page({
  data: {
    statusBarHeight: 0,
    // 用户信息
    userInfo: {
      avatar: '',
      username: '卡包用户'
    },
    // 统计数据
    stats: {
      cardCount: 0,
      totalLimit: '0',
      installmentCount: 0
    },
    // 弹窗显示状态
    showSubscriptionPopup: false,
    showAboutPopup: false,
    showUsernameEditModal: false,
    showImportExportPopup: false,
    showExportOptionsPopup: false,
    // 导出选项
    exportOptions: {
      card: true,
      bill: true
    },
    // 订阅设置
    subscriptions: {
      paymentReminder: true,
      billReminder: true
    },
    paymentReminderEnabled: true,
    // 续收提醒相关
    renewalNotifications: {
      billReminder: {
        count: 58,
        enabled: true
      }
    },
    // 用户名编辑相关
    editingUsername: ''
  },

  onLoad: async function (options) {
    // 获取系统状态栏高度
    const systemInfo = wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: systemInfo.statusBarHeight
    })
    
    // 初始化并加载用户数据（确保清缓存后也能回拉云端昵称）
    const userManager = getUserManager()
    await userManager.init()
    this.loadUserData()
    // 加载统计数据
    this.loadStatsData()
  },

  // 加载用户数据
  loadUserData: function() {
    try {
      const userManager = getUserManager()
      const userInfo = userManager.getUserInfo()
      if (userInfo) {
        this.setData({
          userInfo: {
            avatar: userInfo.avatarUrl || '',
            username: userInfo.nickName || '卡包用户'
          }
        })
      }
    } catch (error) {
      console.error('加载用户数据失败:', error)
    }
  },

  // 加载统计数据
  loadStatsData: async function() {
    try {
      const cardDataManager = getCardDataManager()
      const billDataManager = getBillDataManager()
      
      // 获取卡片数量
      const cards = await cardDataManager.getCardList()
      const cardCount = cards ? cards.length : 0
      
      // 计算总额度
      let totalLimit = 0
      if (cards) {
        cards.forEach(card => {
          if (card.limit) {
            const cardLimit = parseFloat(card.limit.toString().replace(/,/g, '')) || 0
            totalLimit += cardLimit
          }
        })
      }
      
      // 获取分期账单数量
      const bills = await billDataManager.getBillList()
      const installmentCount = bills ? bills.length : 0
      
      // 格式化总额度数字
      const formattedTotalLimit = totalLimit.toLocaleString()
      
      this.setData({
        stats: {
          cardCount,
          totalLimit: formattedTotalLimit,
          installmentCount
        }
      })
    } catch (error) {
      console.error('加载统计数据失败:', error)
    }
  },

  // 更换头像
  changeAvatar: function() {
    const that = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: function(res) {
        const tempFilePath = res.tempFiles[0].tempFilePath
        that.setData({
          'userInfo.avatar': tempFilePath
        })
        
        // 保存到用户信息
        const userManager = getUserManager()
        const userInfo = userManager.getUserInfo() || {}
        userInfo.avatarUrl = tempFilePath
        userManager.saveUserInfo(userInfo)
        
        wx.showToast({
          title: '头像已更新',
          icon: 'success'
        })
      },
      fail: function(error) {
        // 用户取消选择时不显示错误提示
        if (error.errMsg && error.errMsg.includes('cancel')) {
          console.log('用户取消选择头像')
          return
        }
        // 其他错误才显示提示
        console.error('选择头像失败:', error)
        wx.showToast({
          title: '选择头像失败',
          icon: 'none'
        })
      }
    })
  },

  // 编辑用户名
  editUsername: function() {
    this.setData({
      showUsernameEditModal: true,
      editingUsername: this.data.userInfo.username
    })
    // 隐藏底部导航栏
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
  },

  // 用户名输入
  onUsernameInput: function(e) {
    this.setData({
      editingUsername: e.detail.value
    })
  },

  // 确认修改用户名
  confirmUsernameEdit: async function() {
    const newUsername = this.data.editingUsername.trim()
    if (!newUsername) {
      wx.showToast({
        title: '用户名不能为空',
        icon: 'none'
      })
      return
    }
    
    this.setData({
      'userInfo.username': newUsername,
      showUsernameEditModal: false
    })
    
    // 显示底部导航栏
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    // 保存到用户信息（本地+云端）
    const userManager = getUserManager()
    try {
      await userManager.updateNickname(newUsername)
    } catch (e) {
      console.warn('昵称同步失败:', e)
    }
    
    wx.showToast({
      title: '用户名已更新',
      icon: 'success'
    })
  },

  // 取消编辑用户名
  cancelUsernameEdit: function() {
    this.setData({
      showUsernameEditModal: false,
      editingUsername: ''
    })
    // 显示底部导航栏
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
  },

  // 显示消息订阅弹窗
  showMessageSubscription: function() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    // 加载当前订阅设置，确保显示实际的用户状态
    const subscriptions = wx.getStorageSync('subscriptions') || {
      paymentReminder: false,  // 默认为关闭状态，避免误导用户
      billReminder: false
    }
    
    // 加载续收提醒设置
    const renewalSettings = wx.getStorageSync('renewalNotifications') || {
      billReminder: {
        count: 0,
        enabled: false
      }
    }
    
    this.setData({
      showSubscriptionPopup: true,
      subscriptions,
      paymentReminderEnabled: subscriptions.paymentReminder,
      renewalNotifications: renewalSettings
    })
  },

  // 隐藏消息订阅弹窗
  hideSubscriptionPopup: function() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.setData({
      showSubscriptionPopup: false
    })
  },

  // 显示关于我们弹窗
  showAbout: function() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    this.setData({
      showAboutPopup: true
    })
  },

  // 隐藏关于我们弹窗
  hideAboutPopup: function() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.setData({
      showAboutPopup: false
    })
  },

  // 支付提醒开关切换
  togglePaymentReminder: function(e) {
    const enabled = e.detail.value
    this.setData({
      paymentReminderEnabled: enabled,
      'subscriptions.paymentReminder': enabled
    })
    
    if (enabled) {
      // 请求订阅消息
      wx.requestSubscribeMessage({
        tmplIds: ['your-template-id'], // 需要替换为实际的模板ID
        success: (res) => {
          console.log('订阅成功', res)
        },
        fail: (err) => {
          console.log('订阅失败', err)
          this.setData({
            paymentReminderEnabled: false,
            'subscriptions.paymentReminder': false
          })
        }
      })
    }
  },

  // 续收提醒
  renewSubscription: function() {
    const renewalNotifications = this.data.renewalNotifications
    renewalNotifications.billReminder.count += 1
    
    this.setData({
      renewalNotifications
    })
    
    wx.showToast({
      title: '续收成功',
      icon: 'success'
    })
  },

  // 确认订阅设置
  confirmSubscription: function() {
    // 保存订阅设置到本地存储
    const currentSubscriptions = {
      paymentReminder: this.data.paymentReminderEnabled,
      billReminder: this.data.subscriptions.billReminder
    }
    
    wx.setStorageSync('subscriptions', currentSubscriptions)
    
    // 保存续收提醒设置
    wx.setStorageSync('renewalNotifications', this.data.renewalNotifications)
    
    wx.showToast({
      title: '设置已保存',
      icon: 'success'
    })
    this.hideSubscriptionPopup()
  },



  onReady: function () {
    // 页面初次渲染完成
  },

  onShow: function () {
    // 设置自定义tabBar选中状态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 2
      })
    }
    
    // 页面显示时刷新统计数据
    this.refreshStats()
  },

  // 刷新统计数据
  refreshStats: function() {
    this.loadStatsData()
  },

  // 阻止事件冒泡
  stopPropagation: function() {
    // 阻止事件冒泡
  },

  onHide: function () {

  },

  onUnload: function () {

  },

  onPullDownRefresh: function () {
    this.loadUserData()
    this.loadStatsData()
    
    setTimeout(() => {
      wx.stopPullDownRefresh()
    }, 1000)
  },

  onReachBottom: function () {

  },

  onShareAppMessage: function () {

  },

  // 消息订阅功能禁用提示
  showMessageSubscriptionDisabled: function() {
    wx.showToast({
      title: '功能开发中',
      icon: 'none',
      duration: 2000
    })
  },

  // 跳转到还款记录页面
  goToPaymentHistory: function() {
    wx.navigateTo({
      url: '/pages/payment-history/payment-history'
    })
  },

  // 显示导入/导出数据弹窗
  showImportExportPopup: function() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    this.setData({
      showImportExportPopup: true
    })
  },

  // 隐藏导入/导出数据弹窗
  hideImportExportPopup: function() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.setData({
      showImportExportPopup: false
    })
  },

  // 显示导出选项弹窗
  showExportOptions: function() {
    // 重置为默认全选
    this.setData({
      showImportExportPopup: false,
      showExportOptionsPopup: true,
      exportOptions: {
        card: true,
        bill: true
      }
    })
  },

  // 隐藏导出选项弹窗
  hideExportOptionsPopup: function() {
    this.setData({
      showExportOptionsPopup: false
    })
    
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
  },

  // 切换卡包数据导出选项
  toggleExportCard: function() {
    this.setData({
      'exportOptions.card': !this.data.exportOptions.card
    })
  },

  // 切换分期账单导出选项
  toggleExportBill: function() {
    this.setData({
      'exportOptions.bill': !this.data.exportOptions.bill
    })
  },

  // 确认导出数据
  confirmExportData: async function() {
    const { card, bill } = this.data.exportOptions
    
    // 至少选择一项
    if (!card && !bill) {
      wx.showToast({
        title: '请至少选择一项',
        icon: 'none'
      })
      return
    }
    
    try {
      wx.showLoading({ title: '导出中...' })
      
      const exportData = {
        version: '1.0.0',
        exportTime: new Date().toISOString(),
        data: {}
      }
      
      // 导出卡包数据
      if (card) {
        const cardDataManager = getCardDataManager()
        const cardList = await cardDataManager.getCardList()
        exportData.data.cards = cardList
      }
      
      // 导出分期账单数据
      if (bill) {
        const billDataManager = getBillDataManager()
        const billList = await billDataManager.getBillList()
        exportData.data.bills = billList
      }
      
      // 将数据保存为文件
      const fs = wx.getFileSystemManager()
      const fileName = `卡帮手数据备份_${new Date().getTime()}.json`
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`
      
      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8')
      
      // 分享文件
      wx.shareFileMessage({
        filePath: filePath,
        fileName: fileName,
        success: () => {
          wx.hideLoading()
          wx.showToast({
            title: '导出成功',
            icon: 'success'
          })
          this.hideExportOptionsPopup()
        },
        fail: (err) => {
          wx.hideLoading()
          console.error('分享文件失败:', err)
          wx.showToast({
            title: '导出失败',
            icon: 'none'
          })
        }
      })
      
    } catch (error) {
      wx.hideLoading()
      console.error('导出数据失败:', error)
      wx.showToast({
        title: '导出失败',
        icon: 'none'
      })
    }
  },

  // 导入数据
  handleImportData: function() {
    const that = this
    
    // 隐藏导入导出弹窗
    this.hideImportExportPopup()
    
    // 选择文件
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: async (res) => {
        try {
          wx.showLoading({ title: '导入中...' })
          
          const file = res.tempFiles[0]
          
          // 验证文件大小（限制10MB）
          if (file.size > 10 * 1024 * 1024) {
            wx.hideLoading()
            wx.showToast({
              title: '文件过大，请选择小于10MB的文件',
              icon: 'none',
              duration: 2000
            })
            return
          }
          
          // 读取文件内容
          const fs = wx.getFileSystemManager()
          const fileContent = fs.readFileSync(file.path, 'utf8')
          
          // 解析JSON数据
          let importData
          try {
            importData = JSON.parse(fileContent)
          } catch (parseError) {
            wx.hideLoading()
            wx.showToast({
              title: '文件格式错误',
              icon: 'none',
              duration: 2000
            })
            return
          }
          
          // 验证数据格式
          if (!importData.version || !importData.data) {
            wx.hideLoading()
            wx.showToast({
              title: '数据格式不正确',
              icon: 'none',
              duration: 2000
            })
            return
          }
          
          wx.hideLoading()
          
          // 询问用户是否覆盖现有数据
          const hasCardData = importData.data.cards && importData.data.cards.length > 0
          const hasBillData = importData.data.bills && importData.data.bills.length > 0
          
          let confirmMessage = '确定要导入数据吗？\n'
          if (hasCardData) {
            confirmMessage += `\n• 卡包数据：${importData.data.cards.length}条`
          }
          if (hasBillData) {
            confirmMessage += `\n• 分期账单：${importData.data.bills.length}条`
          }
          confirmMessage += '\n\n导入后将覆盖现有数据！'
          
          wx.showModal({
            title: '确认导入',
            content: confirmMessage,
            confirmText: '确定导入',
            cancelText: '取消',
            success: async (modalRes) => {
              if (modalRes.confirm) {
                await that.performImport(importData)
              }
            }
          })
          
        } catch (error) {
          wx.hideLoading()
          console.error('导入数据失败:', error)
          wx.showToast({
            title: '导入失败',
            icon: 'none',
            duration: 2000
          })
        }
      },
      fail: (err) => {
        console.log('选择文件失败:', err)
        // 用户取消选择时不提示
        if (!err.errMsg || !err.errMsg.includes('cancel')) {
          wx.showToast({
            title: '选择文件失败',
            icon: 'none'
          })
        }
      }
    })
  },

  // 执行导入操作
  performImport: async function(importData) {
    try {
      wx.showLoading({ title: '正在导入...' })
      
      let importedCount = 0
      
      // 导入卡包数据
      if (importData.data.cards && importData.data.cards.length > 0) {
        const cardDataManager = getCardDataManager()
        await cardDataManager.saveCardList(importData.data.cards)
        importedCount += importData.data.cards.length
        console.log(`成功导入${importData.data.cards.length}条卡包数据`)
      }
      
      // 导入分期账单数据
      if (importData.data.bills && importData.data.bills.length > 0) {
        const billDataManager = getBillDataManager()
        await billDataManager.saveBillList(importData.data.bills)
        importedCount += importData.data.bills.length
        console.log(`成功导入${importData.data.bills.length}条分期账单数据`)
      }
      
      wx.hideLoading()
      
      // 刷新统计数据
      this.loadStatsData()
      
      wx.showToast({
        title: `导入成功！共${importedCount}条数据`,
        icon: 'success',
        duration: 2000
      })
      
    } catch (error) {
      wx.hideLoading()
      console.error('执行导入失败:', error)
      wx.showToast({
        title: '导入失败',
        icon: 'none',
        duration: 2000
      })
    }
  },

  // 分享给朋友
  onShareAppMessage: function() {
    return {
      title: '我的"负债清零"计划进行中！',
      path: '/pages/settings/settings',
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
})