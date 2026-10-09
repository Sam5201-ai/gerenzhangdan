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
    this.CARD_PENDING_KEY = 'card_pending_ops'
  }

  // ========== 离线待同步队列（云端失败时记录，恢复联网后自动上行） ==========

  // 读取待同步操作队列，格式：[{ t: 'u'|'d', id, at }]
  getPendingOps(key) {
    try {
      const ops = wx.getStorageSync(key)
      return Array.isArray(ops) ? ops : []
    } catch (e) {
      return []
    }
  }

  setPendingOps(key, ops) {
    try {
      wx.setStorageSync(key, ops)
    } catch (e) {
      console.warn('[CardDataManager] 保存待同步队列失败', e)
    }
  }

  // 追加待同步操作；同一 id 只保留最新一条（单人使用，最后操作为准）
  markPending(key, t, id) {
    if (!id) return
    const ops = this.getPendingOps(key).filter(op => op.id !== id)
    ops.push({ t, id, at: Date.now() })
    this.setPendingOps(key, ops)
  }

  // 离线保存成功的统一提示
  toastOfflineSaved() {
    wx.showToast({ title: '已离线保存，联网后自动同步', icon: 'none', duration: 2000 })
  }

  // 读取本地缓存的卡片列表（不走云端，用于同步/合并）
  async getCardListLocalOnly() {
    const local = this.storageManager.getLocalData(this.CARD_LIST_KEY)
    return (local && Array.isArray(local.data)) ? local.data : []
  }

  // 同步读取本地缓存（供页面首屏秒开渲染，不发起任何网络请求）
  getCardListCacheSync() {
    const local = this.storageManager.getLocalData(this.CARD_LIST_KEY)
    return (local && Array.isArray(local.data)) ? local.data : null
  }

  // 把本地待上行条目合并进云端拉取结果（防止离线改动被云端数据覆盖）
  mergePendingIntoCards(pulled) {
    const ops = this.getPendingOps(this.CARD_PENDING_KEY)
    if (!ops.length) return pulled
    let merged = Array.isArray(pulled) ? pulled.slice() : []
    // 注意：getCardListLocalOnly 是 async，同步上下文中直接调用会拿到 Promise，
    // 必须用同步的 getLocalData 读取本地缓存（否则迭代时抛 TypeError 导致整个云端读取失败）
    const local = this.storageManager.getLocalData(this.CARD_LIST_KEY)
    const localList = (local && Array.isArray(local.data)) ? local.data : []
    for (const op of ops) {
      if (op.t === 'd') {
        merged = merged.filter(c => c.id !== op.id)
      }
    }
    for (const op of ops) {
      if (op.t !== 'u') continue
      const localItem = localList.find(c => c.id === op.id)
      if (!localItem) continue
      const idx = merged.findIndex(c => c.id === op.id)
      if (idx >= 0) merged[idx] = localItem
      else merged.push(localItem)
    }
    return merged
  }

  // 本地卡片 id（card_ 前缀）在云端创建成功后，回映射为云端 uuid，并同步账单中的引用
  async remapCardAfterUpsert(oldId, cloudRow) {
    if (!oldId || !cloudRow || !cloudRow.id || cloudRow.id === oldId) return
    const cardList = await this.getCardListLocalOnly()
    const updated = cardList.map(c => (c.id === oldId ? {
      ...c,
      id: cloudRow.id,
      createdAt: cloudRow.created_at ? new Date(cloudRow.created_at).getTime() : (c.createdAt || Date.now()),
      updatedAt: cloudRow.updated_at ? new Date(cloudRow.updated_at).getTime() : Date.now()
    } : c))
    await this.storageManager.setData(this.CARD_LIST_KEY, updated, { immediate: false })
    // 队列中引用旧 id 的操作同步更新
    const ops = this.getPendingOps(this.CARD_PENDING_KEY).map(op => (op.id === oldId ? { ...op, id: cloudRow.id } : op))
    this.setPendingOps(this.CARD_PENDING_KEY, ops)
    // 账单缓存中引用该卡片的 cardId 一并更新
    await this.remapCardIdInBills(oldId, cloudRow.id)
  }

  // 更新本地账单缓存中引用旧卡片 id 的 cardId
  async remapCardIdInBills(oldCardId, newCardId) {
    try {
      const { getBillDataManager } = require('./BillDataManager.js')
      const billDataManager = getBillDataManager()
      const local = this.storageManager.getLocalData(billDataManager.BILL_LIST_KEY)
      if (local && Array.isArray(local.data) && local.data.some(b => b.cardId === oldCardId)) {
        const bills = local.data.map(b => (b.cardId === oldCardId ? { ...b, cardId: newCardId } : b))
        await this.storageManager.setData(billDataManager.BILL_LIST_KEY, bills, { immediate: false })
      }
    } catch (e) {
      console.warn('[CardDataManager] 更新账单中的卡片引用失败', e)
    }
  }

  // 将待同步队列上行到云端；全部成功返回 true，任一失败返回 false（剩余操作保留待下次）
  async syncCardPendingOps() {
    let ops = this.getPendingOps(this.CARD_PENDING_KEY)
    if (!ops.length) return true

    let allDone = true
    let cloudRows = null // 惰性加载：仅当存在 card_ 前缀本地卡需要防重比对时，拉取一次云端列表
    for (const op of ops.slice()) {
      try {
        if (op.t === 'u') {
          const cardList = await this.getCardListLocalOnly()
          const item = cardList.find(c => c.id === op.id)
          if (!item) {
            // 本地已不存在该条目，丢弃该操作
            ops = ops.filter(o => o !== op)
            this.setPendingOps(this.CARD_PENDING_KEY, ops)
            continue
          }
          const isLocalId = typeof item.id === 'string' && item.id.startsWith('card_')
          // 防重复：card_ 前缀卡片上行前先与云端比对（卡号优先，其次名称+还款日）。
          // 命中说明该卡云端已存在（如本地 id 曾被异常迁移替换），更新原卡片而非新建，
          // 避免云端出现重复卡
          let targetId
          if (isLocalId) {
            if (!cloudRows) {
              const listResp = await this.cloudApi.call('cards.list')
              cloudRows = (listResp && listResp.data) || []
            }
            const cardNo = String(item.cardNumber || '').replace(/\s+/g, '')
            const matched = cloudRows.find(r => {
              const rowNo = String(r.card_number || '').replace(/\s+/g, '')
              if (cardNo && rowNo) return cardNo === rowNo
              return !!r.name && r.name === item.name && Number(r.due_day) === Number(item.dueDate)
            })
            if (matched) targetId = matched.id
          }
          const resp = await this.cloudApi.call('cards.upsert', {
            card: {
              id: isLocalId ? targetId : item.id,
              name: item.name,
              card_number: item.cardNumber,
              card_limit: item.limit ? Number(String(item.limit).replace(/,/g, '')) : null,
              due_day: Number(item.dueDate),
              style: item.style || null,
              reminder_enabled: !!item.reminderEnabled,
              reminder_days: Number(item.reminderDays || 3)
            }
          })
          if (isLocalId) {
            await this.remapCardAfterUpsert(item.id, resp && resp.data)
          }
          ops = ops.filter(o => o !== op)
          this.setPendingOps(this.CARD_PENDING_KEY, ops)
          console.log(`[CardDataManager] 待同步卡片已上行: ${item.name}`)
        } else if (op.t === 'd') {
          // card_ 前缀 = 从未上云的本地数据，无需云端删除
          if (!(typeof op.id === 'string' && op.id.startsWith('card_'))) {
            await this.cloudApi.call('cards.delete', { id: op.id })
          }
          ops = ops.filter(o => o !== op)
          this.setPendingOps(this.CARD_PENDING_KEY, ops)
        }
      } catch (e) {
        // 连续失败达到 3 次的操作暂时搁置（保留在队列、数据不丢），
        // 不再阻塞后续操作与整体同步状态，避免单个坏数据卡死整个云端读取
        const failCount = (op.failCount || 0) + 1
        ops = ops.map(o => (o === op ? { ...o, failCount } : o))
        this.setPendingOps(this.CARD_PENDING_KEY, ops)
        if (failCount >= 3) {
          console.warn(`[CardDataManager] 操作连续失败${failCount}次，暂时搁置（保留待后续重试）`, op.id, e)
          continue
        }
        console.warn('[CardDataManager] 待同步操作上行失败，稍后自动重试', op, e)
        allDone = false
        break
      }
    }
    return allDone
  }


  /**
   * 获取所有卡片
   * @param {Object} options 选项
   * @returns {Promise<Array>} 卡片列表
   */
  async getCardList(options = {}) {
    try {
      // 云端优先：有登录态且未处于离线退避期时，先同步本地待同步操作，再从云端拉取
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          // 同步失败不阻塞读取：联网可用就拉云端，待上行数据通过 merge 合并进结果，
          // 避免队列中个别操作卡死导致云端数据永远拉不回来（读取与同步解耦）
          await this.syncCardPendingOps()

          {
            const resp = await this.cloudApi.call('cards.list')
            const rows = (resp && resp.data) ? resp.data : []

            let cards = rows.map(r => ({
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

            // 极端情况：拉取成功但本地又产生了新的待同步操作，合并防止覆盖
            if (this.getPendingOps(this.CARD_PENDING_KEY).length) {
              cards = this.mergePendingIntoCards(cards)
            }

            // 写回本地缓存（避免离线时空白）
            await this.storageManager.setData(this.CARD_LIST_KEY, cards, { immediate: false })
            return cards
          }
        } catch (cloudError) {
          // 云端不可用（停用/断网/超时）：回退到本地缓存，避免页面空白
          console.warn('[CardDataManager] 云端不可用，回退使用本地缓存', cloudError)
        }
      }

      const cardList = await this.storageManager.getData(this.CARD_LIST_KEY, {
        useCache: true,
        maxAge: 30 * 60 * 1000, // 30分钟缓存
        syncIfOld: true,
        ...options
      })

      const cards = cardList || []
      
      // 数据迁移：仅将旧的数字ID/缺失ID转换为新的字符串ID
      // 注意：云端 uuid 与本地 card_ 前缀 id 都是合法字符串 id，绝不能重新生成，
      // 否则账单/还款记录中的引用会全部失配（表现为卡包欠款统计为 0）
      let needsUpdate = false
      const migratedCards = cards.map(card => {
        if (typeof card.id === 'number' || !card.id) {
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
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        let cloudSyncFailed = false
        for (const c of cleanedCardList) {
          if (cloudSyncFailed) {
            // 云端已失败：剩余条目全部记入待同步队列，恢复联网后自动上行
            this.markPending(this.CARD_PENDING_KEY, 'u', c.id)
            continue
          }
          try {
            const isLocalId = c.id && String(c.id).startsWith('card_')
            const resp = await this.cloudApi.call('cards.upsert', {
              card: {
                id: isLocalId ? undefined : c.id, // 兼容旧本地id：不强行上云
                name: c.name,
                card_number: c.cardNumber,
                card_limit: c.limit ? Number(String(c.limit).replace(/,/g, '')) : null,
                due_day: Number(c.dueDate),
                style: c.style || null,
                reminder_enabled: !!c.reminderEnabled,
                reminder_days: Number(c.reminderDays || 3)
              }
            })
            if (isLocalId && resp && resp.data) {
              // 本地id在云端创建成功，回映射为云端uuid，防止重复创建
              await this.remapCardAfterUpsert(c.id, resp.data)
            }
          } catch (cloudError) {
            console.warn('[CardDataManager] 云端同步失败，剩余条目已记入待同步队列', cloudError)
            this.markPending(this.CARD_PENDING_KEY, 'u', c.id)
            cloudSyncFailed = true
          }
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
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
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
        } catch (cloudError) {
          // 云端不可用：回退为本地保存，联网后自动同步
          console.warn('[CardDataManager] 云端添加失败，回退为本地保存', cloudError)
          this.toastOfflineSaved()
        }
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

      // 云端已启用但本次不可用：记入待同步队列，恢复联网后自动上行
      if (this.cloudApi.isEnabled()) {
        this.markPending(this.CARD_PENDING_KEY, 'u', validCard.id)
      }

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
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
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
        } catch (cloudError) {
          // 云端不可用：回退为本地更新，联网后自动同步
          console.warn('[CardDataManager] 云端更新失败，回退为本地更新', cloudError)
          this.toastOfflineSaved()
        }
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

      // 云端已启用但本次不可用：记入待同步队列，恢复联网后自动上行
      if (this.cloudApi.isEnabled()) {
        this.markPending(this.CARD_PENDING_KEY, 'u', cardId)
      }

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
      if (this.cloudApi.isEnabled() && this.cloudApi.isCloudLikelyAvailable()) {
        try {
          await this.cloudApi.call('cards.delete', { id: cardId })
          const cardList = await this.getCardList({ useCache: false })
          const idx = cardList.findIndex(c => c.id == cardId)
          if (idx >= 0) cardList.splice(idx, 1)
          await this.storageManager.setData(this.CARD_LIST_KEY, cardList, { immediate: false })
          console.log(`[CardDataManager] 卡片删除成功(云端): ${cardId}`)
          return true
        } catch (cloudError) {
          // 云端不可用：回退为本地删除，联网后自动同步
          console.warn('[CardDataManager] 云端删除失败，回退为本地删除', cloudError)
          this.toastOfflineSaved()
        }
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

      // 云端已启用但本次不可用：记录待同步删除
      if (this.cloudApi.isEnabled()) {
        if (typeof cardId === 'string' && cardId.startsWith('card_')) {
          // 从未上云的本地数据：清除其待上行操作即可
          const ops = this.getPendingOps(this.CARD_PENDING_KEY).filter(op => !(op.id === cardId && op.t === 'u'))
          this.setPendingOps(this.CARD_PENDING_KEY, ops)
        } else {
          this.markPending(this.CARD_PENDING_KEY, 'd', cardId)
        }
      }

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