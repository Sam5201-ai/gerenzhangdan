// pages/settings/settings.js
const { getUserManager } = require('../../utils/UserManager')
const { getCardDataManager } = require('../../utils/CardDataManager')
const { getBillDataManager } = require('../../utils/BillDataManager')
const { getCloudApi, REPAYMENT_REMINDER_TEMPLATE_ID } = require('../../utils/CloudApi')

Page({
  data: {
    statusBarHeight: 0,
    appVersion: getApp().globalData.appVersion,
    // 用户信息
    userInfo: {
      avatar: '',
      username: ''
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
      paymentReminder: false,
      billReminder: false
    },
    paymentReminderEnabled: false,
    isSavingSubscription: false,
    // 续收提醒相关
    renewalNotifications: {
      billReminder: {
        count: 0,
        enabled: false
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
    
    // 先立即读取本地缓存，避免页面先闪默认头像/昵称
    this.loadUserData()

    // 后台初始化并静默刷新用户数据
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
      const userInfo = userManager.getUserInfo() || userManager.getLocalUserInfo?.() || null
      if (userInfo) {
        this.setData({
          userInfo: {
            avatar: userInfo.avatarUrl || '',
            username: userInfo.nickName || ''
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
      
      const cards = await cardDataManager.getCardList()
      const cardCount = cards ? cards.length : 0
      const bills = await billDataManager.getBillList()
      const billList = bills || []

      let totalRemainingAmount = 0
      let monthlyPaymentTotal = 0
      billList.forEach(bill => {
        const remainingAmount = parseFloat((bill.remainingAmount || '0').toString().replace(/,/g, '')) || 0
        const monthlyPayment = parseFloat((bill.monthlyPayment || '0').toString().replace(/,/g, '')) || 0
        totalRemainingAmount += remainingAmount
        if ((parseInt(bill.paidCount) || 0) < (parseInt(bill.totalCount) || 0)) {
          monthlyPaymentTotal += monthlyPayment
        }
      })

      const remainingPeriods = monthlyPaymentTotal > 0 ? Math.round(totalRemainingAmount / monthlyPaymentTotal) : 0
      
      this.setData({
        stats: {
          cardCount,
          totalLimit: Math.round(totalRemainingAmount).toString(),
          installmentCount: remainingPeriods
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
  showMessageSubscription: async function() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }

    wx.showLoading({ title: '加载中...' })
    try {
      const cloudApi = getCloudApi()
      const settings = await cloudApi.getReminderSettings()
      const paymentReminderEnabled = !!settings?.repayment_reminder_enabled
      const renewalCount = Number(settings?.repayment_reminder_count || 0)
      const subscriptions = {
        paymentReminder: paymentReminderEnabled,
        billReminder: paymentReminderEnabled
      }
      const renewalNotifications = {
        billReminder: {
          count: renewalCount,
          enabled: paymentReminderEnabled && renewalCount > 0
        }
      }

      wx.setStorageSync('subscriptions', subscriptions)
      wx.setStorageSync('renewalNotifications', renewalNotifications)

      this.setData({
        showSubscriptionPopup: true,
        subscriptions,
        paymentReminderEnabled,
        renewalNotifications
      })
    } catch (error) {
      console.error('加载订阅设置失败:', error)
      wx.showToast({
        title: '加载订阅设置失败',
        icon: 'none'
      })
      this.hideSubscriptionPopup()
    } finally {
      wx.hideLoading()
    }
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
  togglePaymentReminder: async function(e) {
    const enabled = e.detail.value
    const cloudApi = getCloudApi()

    if (!enabled) {
      this.setData({
        paymentReminderEnabled: false,
        'subscriptions.paymentReminder': false,
        'subscriptions.billReminder': false,
        'renewalNotifications.billReminder.enabled': false
      })
      return
    }

    wx.showLoading({ title: '请求订阅中...' })
    try {
      const res = await cloudApi.requestRepaymentReminderSubscription()
      const accepted = res && res[REPAYMENT_REMINDER_TEMPLATE_ID] === 'accept'
      if (!accepted) {
        this.setData({
          paymentReminderEnabled: false,
          'subscriptions.paymentReminder': false,
          'subscriptions.billReminder': false
        })
        wx.showToast({
          title: '请先允许订阅消息',
          icon: 'none'
        })
        return
      }

      this.setData({
        paymentReminderEnabled: true,
        'subscriptions.paymentReminder': true,
        'subscriptions.billReminder': true,
        'renewalNotifications.billReminder.enabled': this.data.renewalNotifications.billReminder.count > 0
      })
    } catch (err) {
      console.log('订阅失败', err)
      this.setData({
        paymentReminderEnabled: false,
        'subscriptions.paymentReminder': false,
        'subscriptions.billReminder': false
      })
      wx.showToast({
        title: '订阅请求失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 续收提醒
  renewSubscription: async function() {
    wx.showLoading({ title: '续收中...' })
    try {
      const cloudApi = getCloudApi()
      const res = await cloudApi.requestRepaymentReminderSubscription()
      const accepted = res && res[REPAYMENT_REMINDER_TEMPLATE_ID] === 'accept'
      if (!accepted) {
        wx.showToast({
          title: '需允许订阅后才能续收',
          icon: 'none'
        })
        return
      }

      const updated = await cloudApi.renewReminderSubscription()
      const count = Number(updated?.repayment_reminder_count || 0)
      const paymentReminderEnabled = !!updated?.repayment_reminder_enabled
      const renewalNotifications = {
        billReminder: {
          count,
          enabled: paymentReminderEnabled && count > 0
        }
      }

      this.setData({
        renewalNotifications,
        paymentReminderEnabled,
        'subscriptions.paymentReminder': paymentReminderEnabled,
        'subscriptions.billReminder': paymentReminderEnabled
      })

      wx.setStorageSync('renewalNotifications', renewalNotifications)
      wx.showToast({
        title: '续收成功',
        icon: 'success'
      })
    } catch (error) {
      console.error('续收失败:', error)
      wx.showToast({
        title: '续收失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 确认订阅设置
  confirmSubscription: async function() {
    if (this.data.isSavingSubscription) {
      return
    }

    this.setData({ isSavingSubscription: true })
    wx.showLoading({ title: '保存中...' })
    try {
      const cloudApi = getCloudApi()
      const updated = await cloudApi.saveReminderSettings({
        repaymentReminderEnabled: this.data.paymentReminderEnabled
      })

      const count = Number(updated?.repayment_reminder_count || 0)
      const paymentReminderEnabled = !!updated?.repayment_reminder_enabled
      const currentSubscriptions = {
        paymentReminder: paymentReminderEnabled,
        billReminder: paymentReminderEnabled
      }
      const renewalNotifications = {
        billReminder: {
          count,
          enabled: paymentReminderEnabled && count > 0
        }
      }

      wx.setStorageSync('subscriptions', currentSubscriptions)
      wx.setStorageSync('renewalNotifications', renewalNotifications)

      this.setData({
        subscriptions: currentSubscriptions,
        paymentReminderEnabled,
        renewalNotifications
      })

      wx.showToast({
        title: '设置已保存',
        icon: 'success'
      })
      this.hideSubscriptionPopup()
    } catch (error) {
      console.error('保存订阅设置失败:', error)
      wx.showToast({
        title: '保存失败',
        icon: 'none'
      })
    } finally {
      this.setData({ isSavingSubscription: false })
      wx.hideLoading()
    }
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

  // 消息订阅入口
  showMessageSubscriptionEntry: function() {
    this.showMessageSubscription()
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