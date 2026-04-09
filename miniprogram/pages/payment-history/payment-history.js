// pages/payment-history/payment-history.js
const { getBillDataManager } = require('../../utils/BillDataManager.js')
const { getCardDataManager } = require('../../utils/CardDataManager.js')

const HIDDEN_PAYMENT_RECORDS_KEY = 'hidden_payment_records'

Page({
  data: {
    statusBarHeight: 0,
    
    // 筛选相关
    showMonthFilter: false,
    showBankFilter: false,
    selectedMonth: 'all',
    selectedBank: 'all',
    selectedMonthText: '全部月份',
    selectedBankText: '全部银行',
    
    // 月份选择相关
    selectedYear: new Date().getFullYear(),
    selectedMonthNum: new Date().getMonth() + 1,
    yearList: [],
    monthList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    
    // 银行列表
    bankList: [],
    
    // 还款记录数据
    paymentRecords: [],
    groupedRecords: [],
    
    // 是否显示空状态
    isEmpty: false
  },

  onLoad: function(options) {
    // 获取状态栏高度
    const systemInfo = wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: systemInfo.statusBarHeight
    })
    
    // 初始化管理器
    this.billDataManager = getBillDataManager()
    this.cardDataManager = getCardDataManager()
    
    // 生成年份列表（最近5年）
    const currentYear = new Date().getFullYear()
    const yearList = []
    for (let i = 0; i < 5; i++) {
      yearList.push(currentYear - i)
    }
    this.setData({ yearList })
    
    // 加载数据
    this.loadData()
  },

  // 加载数据
  async loadData() {
    try {
      wx.showLoading({ title: '加载中...' })
      
      // 加载银行列表
      await this.loadBankList()
      
      // 加载还款记录
      await this.loadPaymentRecords()
      
      wx.hideLoading()
    } catch (error) {
      console.error('加载数据失败:', error)
      wx.hideLoading()
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      })
    }
  },

  // 加载银行列表
  async loadBankList() {
    try {
      const cardList = await this.cardDataManager.getCardList()
      this._cardStyleCache = cardList || []
      const billList = await this.billDataManager.getBillList({ useCache: false })
      this._billCache = billList || []
      const bankSet = new Set()
      
      cardList.forEach(card => {
        if (card.name) {
          bankSet.add(card.name)
        }
      })
      
      this.setData({
        bankList: Array.from(bankSet)
      })
    } catch (error) {
      console.error('加载银行列表失败:', error)
    }
  },

  // 加载还款记录
  async loadPaymentRecords() {
    try {
      // 直接从还款历史记录中获取数据（不使用缓存，确保获取最新数据）
      const paymentHistory = await this.billDataManager.getPaymentHistory({ useCache: false })
      this._paymentHistoryCache = paymentHistory || []
      
      console.log('获取到的还款历史记录:', paymentHistory)
      console.log('还款历史记录数量:', paymentHistory ? paymentHistory.length : 0)
      
      // 如果没有还款历史记录，显示空状态
      if (!paymentHistory || paymentHistory.length === 0) {
        console.log('没有还款历史记录，显示空状态')
        this.setData({
          isEmpty: true,
          paymentRecords: [],
          groupedRecords: []
        })
        return
      }
      
      // 处理还款历史数据
      const hiddenIds = this.getHiddenPaymentRecordIds()
      const records = paymentHistory
        .filter(record => !hiddenIds.includes(record.id))
        .map(record => {
        let paymentDate = this.parsePaymentDate(record.paymentDate, record.createdAt)
        
        return {
          id: record.id,
          billId: record.billId,
          bankName: record.cardName || '未知银行',
          cardNumber: record.cardNumber || '',
          cardStyle: record.cardStyle || this.getCardStyleByName(record.cardName),
          amount: parseFloat(record.amount) || 0,
          currentPeriod: this.shouldDeriveCurrentPeriod(record)
            ? this.deriveCurrentPeriod(record)
            : Number(record.currentPeriod),
          totalPeriods: this.shouldDeriveCurrentPeriod(record)
            ? this.deriveTotalPeriods(record)
            : Number(record.totalPeriods),
          paymentTime: paymentDate.toISOString(),
          formattedTime: this.formatTime(paymentDate.toISOString()),
          paymentMonth: `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, '0')}`
        }
      })
      
      // 按时间倒序排序
      records.sort((a, b) => new Date(b.paymentTime) - new Date(a.paymentTime))
      
      console.log('处理后的还款记录:', records)
      
      this.setData({
        paymentRecords: records,
        isEmpty: records.length === 0
      })
      
      console.log('设置数据后的状态:', { 
        recordsCount: records.length, 
        isEmpty: records.length === 0
      })
      
      // 分组显示
      this.groupRecordsByMonth()
      
    } catch (error) {
      console.error('加载还款记录失败:', error)
      this.setData({
        isEmpty: true,
        paymentRecords: [],
        groupedRecords: []
      })
    }
  },

  // 从账单数据加载还款记录（兼容旧数据）
  async loadPaymentRecordsFromBills() {
    try {
      const billList = await this.billDataManager.getBillList({ useCache: false })
      
      console.log('获取到的账单数据:', billList)
      
      if (!billList || billList.length === 0) {
        this.setData({
          isEmpty: true,
          paymentRecords: [],
          groupedRecords: []
        })
        return
      }
      
      // 处理账单数据，生成还款记录
      const records = []
      
      billList.forEach(bill => {
        const totalCount = parseInt(bill.totalCount) || 0
        const paidCount = parseInt(bill.paidCount) || 0
        
        console.log(`账单 ${bill.cardName}: 总期数=${totalCount}, 已还期数=${paidCount}`)
        
        // 如果有已还期数，生成还款记录
        if (paidCount > 0) {
          const monthlyPayment = parseFloat(bill.monthlyPayment?.toString().replace(/,/g, '')) || 0
          
          // 基于真实的还款数据生成记录
          for (let i = 1; i <= paidCount; i++) {
            // 使用最后还款日期作为基准，如果没有则使用当前时间
            let paymentDate = new Date()
            
            if (bill.lastPaymentDate) {
              // 解析最后还款日期（格式：2024年10月20日）
              const dateMatch = bill.lastPaymentDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
              if (dateMatch) {
                const [, year, month, day] = dateMatch
                // 设置一个合理的还款时间（上午10点）
                paymentDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 10, 0, 0)
                
                // 为每期还款生成不同的日期（向前推算）
                if (i < paidCount) {
                  paymentDate.setMonth(paymentDate.getMonth() - (paidCount - i))
                }
              }
            } else {
              // 如果没有最后还款日期，按月份向前推算，设置合理的时间
              paymentDate.setMonth(paymentDate.getMonth() - (paidCount - i))
              paymentDate.setHours(10, 0, 0, 0)
            }
            
            records.push({
              id: `${bill.id}-${i}`,
              bankName: bill.cardName || '未知银行',
              cardStyle: 'blue', // 默认样式
              amount: monthlyPayment,
              currentPeriod: i,
              totalPeriods: totalCount,
              paymentTime: paymentDate.toISOString(),
              formattedTime: this.formatTime(paymentDate.toISOString()),
              paymentMonth: `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, '0')}`
            })
          }
        }
      })
      
      // 按时间倒序排序
      records.sort((a, b) => new Date(b.paymentTime) - new Date(a.paymentTime))
      
      console.log('从账单生成的还款记录:', records)
      
      this.setData({
        paymentRecords: records,
        isEmpty: records.length === 0
      })
      
      console.log('设置数据后的状态:', { 
        recordsCount: records.length, 
        isEmpty: records.length === 0
      })
      
      // 分组显示
      this.groupRecordsByMonth()
      
    } catch (error) {
      console.error('从账单数据加载还款记录失败:', error)
      this.setData({
        isEmpty: true,
        paymentRecords: [],
        groupedRecords: []
      })
    }
  },

  getCardStyleByName(cardName) {
    const cards = this._cardStyleCache || []
    const matched = cards.find(card => card.name === cardName)
    return matched?.style || 'blue'
  },

  shouldDeriveCurrentPeriod(record) {
    const current = Number(record?.currentPeriod || 0)
    const total = Number(record?.totalPeriods || 0)
    if (current <= 0) return true
    if (total <= 0) return true

    const history = this._paymentHistoryCache || []
    const sameBillCount = history.filter(item => item.billId === record.billId).length
    if (sameBillCount > 1 && current === 1 && total === 1) return true

    return false
  },

  deriveCurrentPeriod(record) {
    const history = this._paymentHistoryCache || []
    const sameBillRecords = history
      .filter(item => item.billId === record.billId)
      .slice()
      .sort((a, b) => {
        const dateDiff = this.parsePaymentDate(a.paymentDate, a.createdAt) - this.parsePaymentDate(b.paymentDate, b.createdAt)
        if (dateDiff !== 0) return dateDiff
        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
      })

    const recordIndex = sameBillRecords.findIndex(item => item.id === record.id)
    if (recordIndex >= 0) return recordIndex + 1

    const explicitCurrent = Number(record?.currentPeriod || 0)
    if (explicitCurrent > 0) return explicitCurrent

    const bill = this.findBillById(record.billId)
    return bill?.paidCount || 1
  },

  deriveTotalPeriods(record) {
    const explicitTotal = Number(record?.totalPeriods || 0)
    if (explicitTotal > 0 && !(explicitTotal === 1 && this.shouldDeriveCurrentPeriod(record))) {
      return explicitTotal
    }
    const bill = this.findBillById(record.billId)
    return bill?.totalCount || 1
  },

  findBillById(billId) {
    const bills = this._billCache || []
    return bills.find(item => item.id === billId) || null
  },

  parsePaymentDate(paymentDateValue, createdAtValue) {
    if (paymentDateValue) {
      const raw = String(paymentDateValue)
      const cn = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
      if (cn) {
        return new Date(parseInt(cn[1]), parseInt(cn[2]) - 1, parseInt(cn[3]), 10, 0, 0)
      }
      const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
      if (ymd) {
        return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]), 10, 0, 0)
      }
      const dt = new Date(raw)
      if (!isNaN(dt.getTime())) return dt
    }
    if (createdAtValue) {
      const dt = new Date(createdAtValue)
      if (!isNaN(dt.getTime())) return dt
    }
    return new Date()
  },

  getHiddenPaymentRecordIds() {
    try {
      return wx.getStorageSync(HIDDEN_PAYMENT_RECORDS_KEY) || []
    } catch (e) {
      return []
    }
  },

  saveHiddenPaymentRecordIds(ids) {
    try {
      wx.setStorageSync(HIDDEN_PAYMENT_RECORDS_KEY, ids)
    } catch (e) {
      console.warn('保存隐藏还款记录失败', e)
    }
  },

  handleDeleteRecord(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '隐藏记录',
      content: '确定隐藏这条还款记录吗？该操作不会影响分期账单数据。',
      success: (res) => {
        if (!res.confirm) return
        const ids = this.getHiddenPaymentRecordIds()
        if (!ids.includes(id)) ids.push(id)
        this.saveHiddenPaymentRecordIds(ids)
        this.loadPaymentRecords()
        wx.showToast({ title: '已隐藏', icon: 'success' })
      }
    })
  },

  // 按月份分组记录
  groupRecordsByMonth() {
    const { paymentRecords, selectedMonth, selectedBank } = this.data
    
    // 筛选记录
    let filteredRecords = paymentRecords
    
    if (selectedMonth !== 'all') {
      filteredRecords = filteredRecords.filter(record => record.paymentMonth === selectedMonth)
    }
    
    if (selectedBank !== 'all') {
      filteredRecords = filteredRecords.filter(record => record.bankName === selectedBank)
    }
    
    // 按月份分组
    const groups = {}
    
    filteredRecords.forEach(record => {
      const month = record.paymentMonth
      if (!groups[month]) {
        groups[month] = {
          month: month,
          monthText: this.formatMonthText(month),
          records: [],
          totalAmount: 0
        }
      }
      groups[month].records.push(record)
      groups[month].totalAmount += record.amount
    })
    
    // 转换为数组并排序
    const groupedRecords = Object.values(groups).sort((a, b) => b.month.localeCompare(a.month))
    
    console.log('分组后的记录:', groupedRecords)
    console.log('筛选条件:', { selectedMonth, selectedBank })
    
    this.setData({
      groupedRecords: groupedRecords,
      isEmpty: groupedRecords.length === 0
    })
  },

  // 格式化月份文本
  formatMonthText(monthStr) {
    const [year, month] = monthStr.split('-')
    return `${year}年${parseInt(month)}月`
  },

  // 格式化时间
  formatTime(timeStr) {
    const date = new Date(timeStr)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
  },

  // 显示月份筛选
  showMonthFilterPopup() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    this.setData({
      showMonthFilter: true
    })
  },

  // 隐藏月份筛选
  hideMonthFilter() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.setData({
      showMonthFilter: false
    })
  },

  // 显示银行筛选
  showBankFilterPopup() {
    // 隐藏自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: true
      })
    }
    
    this.setData({
      showBankFilter: true
    })
  },

  // 隐藏银行筛选
  hideBankFilter() {
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.setData({
      showBankFilter: false
    })
  },

  // 选择年份
  onYearChange(e) {
    this.setData({
      selectedYear: this.data.yearList[e.detail.value]
    })
  },

  // 选择月份
  onMonthChange(e) {
    this.setData({
      selectedMonthNum: this.data.monthList[e.detail.value]
    })
  },

  // 确认月份筛选
  confirmMonthFilter() {
    const { selectedYear, selectedMonthNum } = this.data
    const monthStr = `${selectedYear}-${String(selectedMonthNum).padStart(2, '0')}`
    const monthText = `${selectedYear}年${selectedMonthNum}月`
    
    this.setData({
      selectedMonth: monthStr,
      selectedMonthText: monthText,
      showMonthFilter: false
    })
    
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.groupRecordsByMonth()
  },

  // 重置月份筛选
  resetMonthFilter() {
    this.setData({
      selectedMonth: 'all',
      selectedMonthText: '全部月份',
      showMonthFilter: false
    })
    
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.groupRecordsByMonth()
  },

  // 选择银行
  selectBank(e) {
    const bank = e.currentTarget.dataset.bank
    
    this.setData({
      selectedBank: bank,
      selectedBankText: bank === 'all' ? '全部银行' : bank,
      showBankFilter: false
    })
    
    // 显示自定义tabBar
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        hidden: false
      })
    }
    
    this.groupRecordsByMonth()
  },

  // 阻止事件冒泡
  stopPropagation() {
    // 空函数，用于阻止事件冒泡
  },

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  onShow: function() {
    // 页面显示时重新加载数据，确保显示最新的还款记录
    this.loadData()
  },

  onPullDownRefresh: function() {
    // 下拉刷新
    this.loadData().then(() => {
      wx.stopPullDownRefresh()
    })
  }
})

