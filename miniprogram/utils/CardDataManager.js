/**
 * 卡片数据管理器 - 提供统一的数据管理接口
 * 为卡包助手提供数据存储功能
 */

const { getStorageManager } = require('./StorageManager.js')
const { getCloudApi } = require('./CloudApi.js')

class CardDataManager {
  constructor() {
    this.storageManager = getStorageManager()
    this.cloudApi = getCloudApi()
    this.CARD_LIST_KEY = 'cardList'
  }

  /**
   * 获取所有卡片
   * @param {Object} options 选项
   * @returns {Promise<Array>} 卡片列表
   */
  async getCardList(options = {}) {
    try {
      // 云端优先：如果有登录态，则直接从云端拉取，并写回本地缓存
      if (this.cloudApi.isEnabled()) {
        const resp = await this.cloudApi.call('cards.list')
        const rows = (resp && resp.data) ? resp.data : []

        const cards = rows.map(r => ({
          // 本地仍沿用原字段名，保持页面无感
          id: r.id,
          name: r.name,
          cardNumber: r.card_number,
          limit: r.card_limit != null ? String(r.card_limit) : '',
          dueDate: r.due_day,
          style: r.style || 'blue',
          reminderEnabled: !!r.reminder_enabled,
          reminderDays: r.reminder_days || 3,
          createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
          updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now()
        }))

        // 写回本地缓存（避免离线时空白）
        await this.storageManager.setData(this.CARD_LIST_KEY, cards, { immediate: false })
        return cards
      }

      const cardList = await this.storageManager.getData(this.CARD_LIST_KEY, {
        useCache: true,
        maxAge: 30 * 60 * 1000, // 30分钟缓存
        syncIfOld: true,
        ...options
      })

      const cards = cardList || []
      
      // 数据迁移：将旧的数字ID转换为新的字符串ID
      let needsUpdate = false
      const migratedCards = cards.map(card => {
        if (typeof card.id === 'number' || !card.id || !card.id.toString().startsWith('card_')) {
          needsUpdate = true
          return {
            ...card,
            id: this.generateCardId()
          }
        }
        return card
      })
      
      // 如果有数据需要迁移，保存更新后的数据
      if (needsUpdate) {
        await this.saveCardList(migratedCards, { immediate: true })
        console.log('[CardDataManager] 卡片ID已迁移到新格式')
        return migratedCards
      }
      
      return cards
    } catch (error) {
      console.error('[CardDataManager] 获取卡片列表失败', error)
      return []
    }
  }

  /**
   * 保存卡片列表
   * @param {Array} cardList 卡片列表
   * @param {Object} options 选项
   */
  async saveCardList(cardList, options = {}) {
    try {
      console.log(`[CardDataManager] 开始保存卡片列表，选项:`, options)
      
      // 数据验证
      if (!Array.isArray(cardList)) {
        throw new Error('卡片列表必须是数组')
      }

      // 清理和验证卡片数据
      const cleanedCardList = cardList.map(card => this.validateAndCleanCard(card))
      
      console.log(`[CardDataManager] 准备调用StorageManager.setData，key=${this.CARD_LIST_KEY}`)

      await this.storageManager.setData(this.CARD_LIST_KEY, cleanedCardList, {
        immediate: false, // 默认批量同步
        priority: 'normal',
        ...options
      })

      // 云端同步：逐条 upsert（数据量通常不大；后续可优化为批量 RPC）
      if (this.cloudApi.isEnabled()) {
        for (const c of cleanedCardList) {
          await this.cloudApi.call('cards.upsert', {
            card: {
              id: c.id && String(c.id).startsWith('card_') ? undefined : c.id, // 兼容旧本地id：不强行上云
              name: c.name,
              card_number: c.cardNumber,
              card_limit: c.limit ? Number(String(c.limit).replace(/,/g, '')) : null,
              due_day: Number(c.dueDate),
              style: c.style || null,
              reminder_enabled: !!c.reminderEnabled,
              reminder_days: Number(c.reminderDays || 3)
            }
          })
        }
      }

      console.log(`[CardDataManager] 卡片列表已保存，共${cleanedCardList.length}张卡片`)
      return true

    } catch (error) {
      console.error('[CardDataManager] 保存卡片列表失败', error)
      throw error
    }
  }

  /**
   * 添加卡片
   * @param {Object} card 卡片数据
   * @returns {Promise<Object>} 添加的卡片（包含ID）
   */
  async addCard(card) {
    try {
      // 验证卡片数据
      const validCard = this.validateAndCleanCard(card)
      
      // 云端优先：由云端生成 uuid id
      if (this.cloudApi.isEnabled()) {
        const resp = await this.cloudApi.call('cards.upsert', {
          card: {
            name: validCard.name,
            card_number: validCard.cardNumber,
            card_limit: validCard.limit ? Number(String(validCard.limit).replace(/,/g, '')) : null,
            due_day: Number(validCard.dueDate),
            style: validCard.style || null,
            reminder_enabled: !!validCard.reminderEnabled,
            reminder_days: Number(validCard.reminderDays || 3)
          }
        })
        const r = resp?.data
        const saved = {
          ...validCard,
          id: r.id,
          createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
          updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now()
        }
        // 写本地缓存
        const cardList = await this.getCardList({ useCache: false })
        cardList.push(saved)
        await this.storageManager.setData(this.CARD_LIST_KEY, cardList, { immediate: false })
        console.log(`[CardDataManager] 卡片添加成功(云端): ${saved.name}`)
        return saved
      }

      // 本地模式：生成唯一ID
      validCard.id = this.generateCardId()
      validCard.createdAt = Date.now()
      validCard.updatedAt = Date.now()

      // 获取当前列表
      const cardList = await this.getCardList()
      
      // 添加新卡片
      cardList.push(validCard)
      
      // 保存列表
      await this.saveCardList(cardList, { 
        immediate: true, // 新增卡片立即同步
        priority: 'high' 
      })

      console.log(`[CardDataManager] 卡片添加成功: ${validCard.name}`)
      return validCard

    } catch (error) {
      console.error('[CardDataManager] 添加卡片失败', error)
      throw error
    }
  }

  /**
   * 更新卡片
   * @param {number|string} cardId 卡片ID
   * @param {Object} updates 更新数据
   * @returns {Promise<Object>} 更新后的卡片
   */
  async updateCard(cardId, updates) {
    try {
      // 验证更新数据
      const validUpdates = this.validateAndCleanCard(updates, false)

      // 云端优先
      if (this.cloudApi.isEnabled()) {
        const resp = await this.cloudApi.call('cards.upsert', {
          card: {
            id: cardId,
            name: validUpdates.name,
            card_number: validUpdates.cardNumber,
            card_limit: validUpdates.limit ? Number(String(validUpdates.limit).replace(/,/g, '')) : null,
            due_day: Number(validUpdates.dueDate),
            style: validUpdates.style || null,
            reminder_enabled: !!validUpdates.reminderEnabled,
            reminder_days: Number(validUpdates.reminderDays || 3)
          }
        })

        const r = resp?.data
        // 更新本地缓存
        const cardList = await this.getCardList({ useCache: false })
        const cardIndex = cardList.findIndex(card => card.id == cardId)
        const updatedCard = {
          ...(cardIndex >= 0 ? cardList[cardIndex] : {}),
          ...validUpdates,
          id: r?.id || cardId,
          updatedAt: r?.updated_at ? new Date(r.updated_at).getTime() : Date.now()
        }
        if (cardIndex >= 0) cardList[cardIndex] = updatedCard
        else cardList.push(updatedCard)
        await this.storageManager.setData(this.CARD_LIST_KEY, cardList, { immediate: false })
        console.log(`[CardDataManager] 卡片更新成功(云端): ${updatedCard.name}`)
        return updatedCard
      }

      const cardList = await this.getCardList()
      const cardIndex = cardList.findIndex(card => card.id == cardId)

      if (cardIndex === -1) {
        throw new Error(`卡片不存在: ${cardId}`)
      }
      
      // 更新卡片
      const updatedCard = {
        ...cardList[cardIndex],
        ...validUpdates,
        updatedAt: Date.now()
      }
      
      cardList[cardIndex] = updatedCard

      // 保存列表
      await this.saveCardList(cardList, { 
        immediate: true, // 更新卡片立即同步
        priority: 'high' 
      })

      console.log(`[CardDataManager] 卡片更新成功: ${updatedCard.name}`)
      return updatedCard

    } catch (error) {
      console.error('[CardDataManager] 更新卡片失败', error)
      throw error
    }
  }

  /**
   * 删除卡片
   * @param {number|string} cardId 卡片ID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteCard(cardId) {
    try {
      // 云端优先
      if (this.cloudApi.isEnabled()) {
        await this.cloudApi.call('cards.delete', { id: cardId })
        const cardList = await this.getCardList({ useCache: false })
        const idx = cardList.findIndex(c => c.id == cardId)
        if (idx >= 0) cardList.splice(idx, 1)
        await this.storageManager.setData(this.CARD_LIST_KEY, cardList, { immediate: false })
        console.log(`[CardDataManager] 卡片删除成功(云端): ${cardId}`)
        return true
      }

      const cardList = await this.getCardList()
      const cardIndex = cardList.findIndex(card => card.id == cardId)

      if (cardIndex === -1) {
        throw new Error(`卡片不存在: ${cardId}`)
      }

      const deletedCard = cardList[cardIndex]
      cardList.splice(cardIndex, 1)

      // 保存列表
      await this.saveCardList(cardList, { 
        immediate: true, // 删除卡片立即同步
        priority: 'high' 
      })

      console.log(`[CardDataManager] 卡片删除成功: ${deletedCard.name}`)
      return true

    } catch (error) {
      console.error('[CardDataManager] 删除卡片失败', error)
      throw error
    }
  }

  /**
   * 获取单张卡片
   * @param {number|string} cardId 卡片ID
   * @returns {Promise<Object|null>} 卡片数据
   */
  async getCard(cardId) {
    try {
      const cardList = await this.getCardList()
      return cardList.find(card => card.id == cardId) || null
    } catch (error) {
      console.error('[CardDataManager] 获取卡片失败', error)
      return null
    }
  }

  /**
   * 搜索卡片
   * @param {string} query 搜索关键词
   * @returns {Promise<Array>} 匹配的卡片列表
   */
  async searchCards(query) {
    try {
      const cardList = await this.getCardList()
      
      if (!query || query.trim() === '') {
        return cardList
      }

      const searchQuery = query.toLowerCase().trim()
      return cardList.filter(card => 
        card.name.toLowerCase().includes(searchQuery) ||
        card.bankName.toLowerCase().includes(searchQuery) ||
        card.cardNumber.toLowerCase().includes(searchQuery)
      )
    } catch (error) {
      console.error('[CardDataManager] 搜索卡片失败', error)
      return []
    }
  }


  /**
   * 验证和清理卡片数据
   * @param {Object} card 卡片数据
   * @param {boolean} requireAll 是否需要所有必填字段
   * @returns {Object} 验证后的卡片数据
   */
  validateAndCleanCard(card, requireAll = true) {
    if (!card || typeof card !== 'object') {
      throw new Error('无效的卡片数据')
    }

    const cleaned = {}

    // 必填字段验证
    if (requireAll) {
      if (!card.name || typeof card.name !== 'string' || !card.name.trim()) {
        throw new Error('卡片名称不能为空')
      }
      if (!card.cardNumber || typeof card.cardNumber !== 'string' || !card.cardNumber.trim()) {
        throw new Error('卡号不能为空')
      }
      if (!card.limit || (!card.limit.toString().trim())) {
        throw new Error('额度不能为空')
      }
      if (!card.dueDate || isNaN(parseInt(card.dueDate))) {
        throw new Error('还款日期无效')
      }
    }

    // 字段清理和验证
    if (card.id !== undefined) cleaned.id = card.id
    if (card.name) cleaned.name = card.name.toString().trim()
    if (card.bankName) cleaned.bankName = card.bankName.toString().trim()
    if (card.cardNumber) cleaned.cardNumber = card.cardNumber.toString().trim()
    if (card.limit) cleaned.limit = card.limit.toString().trim()
    if (card.dueDate !== undefined) {
      const dueDate = parseInt(card.dueDate)
      if (dueDate >= 1 && dueDate <= 31) {
        cleaned.dueDate = dueDate
      } else if (requireAll) {
        throw new Error('还款日期必须在1-31之间')
      }
    }
    if (card.style) cleaned.style = card.style.toString().trim()
    if (card.reminderEnabled !== undefined) cleaned.reminderEnabled = Boolean(card.reminderEnabled)
    if (card.reminderDays !== undefined) cleaned.reminderDays = parseInt(card.reminderDays) || 3
    if (card.createdAt !== undefined) cleaned.createdAt = card.createdAt
    if (card.updatedAt !== undefined) cleaned.updatedAt = card.updatedAt

    return cleaned
  }

  /**
   * 生成卡片ID
   * @returns {number} 卡片ID
   */
  generateCardId() {
    // 生成更安全的卡片ID：card_时间戳_随机数
    const timestamp = Date.now()
    const random = Math.floor(Math.random() * 100000)
    return `card_${timestamp}_${random}`
  }

  /**
   * 导出卡片数据
   * @returns {Promise<string>} JSON格式的卡片数据
   */
  async exportCards() {
    try {
      const cardList = await this.getCardList()
      const exportData = {
        version: '1.0',
        exportTime: new Date().toISOString(),
        cardCount: cardList.length,
        cards: cardList
      }
      
      const jsonString = JSON.stringify(exportData, null, 2)
      
      // 复制到剪贴板
      wx.setClipboardData({
        data: jsonString,
        success: () => {
          wx.showToast({
            title: '已复制到剪贴板',
            icon: 'success'
          })
        }
      })
      
      return jsonString
    } catch (error) {
      console.error('[CardDataManager] 导出卡片失败', error)
      throw error
    }
  }

  /**
   * 导入卡片数据
   * @returns {Promise<number>} 导入的卡片数量
   */
  async importCards() {
    try {
      const clipboardData = await new Promise((resolve, reject) => {
        wx.getClipboardData({
          success: (res) => resolve(res.data),
          fail: reject
        })
      })

      const importData = JSON.parse(clipboardData)
      
      if (!importData.cards || !Array.isArray(importData.cards)) {
        throw new Error('无效的导入数据格式')
      }

      const currentCards = await this.getCardList()
      let importCount = 0

      for (const card of importData.cards) {
        try {
          // 检查是否已存在相同卡号的卡片
          const exists = currentCards.some(existingCard => 
            existingCard.cardNumber === card.cardNumber
          )

          if (!exists) {
            await this.addCard(card)
            importCount++
          }
        } catch (error) {
          console.warn('[CardDataManager] 跳过无效卡片', card, error)
        }
      }

      wx.showToast({
        title: `成功导入${importCount}张卡片`,
        icon: 'success'
      })

      return importCount

    } catch (error) {
      console.error('[CardDataManager] 导入卡片失败', error)
      wx.showToast({
        title: '导入失败',
        icon: 'error'
      })
      throw error
    }
  }

  /**
   * 获取统计信息
   * @returns {Promise<Object>} 统计信息
   */
  async getStatistics() {
    try {
      const cardList = await this.getCardList()
      const storageStats = this.storageManager.getStorageStats()

      return {
        cardCount: cardList.length,
        totalLimit: cardList.reduce((sum, card) => {
          const limit = parseFloat(card.limit.replace(/[^0-9.]/g, '')) || 0
          return sum + limit
        }, 0),
        bankStats: this.getBankStatistics(cardList),
        storage: storageStats
      }
    } catch (error) {
      console.error('[CardDataManager] 获取统计信息失败', error)
      return null
    }
  }

  /**
   * 获取银行统计
   * @param {Array} cardList 卡片列表
   * @returns {Object} 银行统计
   */
  getBankStatistics(cardList) {
    const bankStats = {}
    
    cardList.forEach(card => {
      const bank = card.bankName || '未知银行'
      if (!bankStats[bank]) {
        bankStats[bank] = { count: 0, totalLimit: 0 }
      }
      bankStats[bank].count++
      
      const limit = parseFloat(card.limit.replace(/[^0-9.]/g, '')) || 0
      bankStats[bank].totalLimit += limit
    })

    return bankStats
  }

  /**
   * 清理数据
   * @param {Object} options 清理选项
   */
  async cleanupData(options = {}) {
    const { 
      clearLocalCache = false
    } = options

    try {
      if (clearLocalCache) {
        this.storageManager.cleanExpiredCache()
      }

      console.log('[CardDataManager] 数据清理完成')
    } catch (error) {
      console.error('[CardDataManager] 数据清理失败', error)
    }
  }
}

// 单例模式
let cardDataManagerInstance = null

/**
 * 获取卡片数据管理器实例
 * @returns {CardDataManager} 卡片数据管理器实例
 */
function getCardDataManager() {
  if (!cardDataManagerInstance) {
    cardDataManagerInstance = new CardDataManager()
  }
  return cardDataManagerInstance
}

module.exports = {
  CardDataManager,
  getCardDataManager
}