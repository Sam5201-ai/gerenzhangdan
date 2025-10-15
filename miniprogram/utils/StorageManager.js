/**
 * 存储管理器 - 实现多级缓存
 * 设计原则：前端缓存优先，本地存储
 */

class StorageManager {
  constructor() {
    this.memoryCache = new Map() // L2内存缓存
  }

  /**
   * 获取数据 - 多级缓存策略
   * @param {string} key 数据键
   * @param {Object} options 选项
   * @returns {Promise} 数据
   */
  async getData(key, options = {}) {
    const { 
      useCache = true, 
      maxAge = 30 * 60 * 1000, // 30分钟缓存
      syncIfOld = true 
    } = options

    try {
      // L2缓存检查
      if (useCache && this.memoryCache.has(key)) {
        const cached = this.memoryCache.get(key)
        if (cached && cached.timestamp) {
          const age = Date.now() - cached.timestamp
          
          if (age < maxAge) {
            console.log(`[StorageManager] 内存缓存命中: ${key}`)
            return cached.data
          }
        }
      }

      // L1本地存储检查
      const localData = this.getLocalData(key)
      if (localData) {
        // 检查数据结构是否正确
        if (localData.data !== undefined) {
          // 安全检查meta对象和lastModified属性
          const meta = localData.meta || {}
          const lastModified = meta.lastModified || 0
          const age = lastModified > 0 ? Date.now() - lastModified : Infinity
          
          // 更新内存缓存
          this.setMemoryCache(key, localData.data)
          
          if (age < maxAge) {
            console.log(`[StorageManager] 本地存储命中: ${key}`)
            return localData.data
          }
        }
      }

      // 返回本地数据（即使过期）或空数据
      if (localData && localData.data !== undefined) {
        return localData.data
      }
      
      return null

    } catch (error) {
      console.error(`[StorageManager] 获取数据失败: ${key}`, error)
      
      // 容错：返回本地缓存
      const localData = this.getLocalData(key)
      return localData && localData.data !== undefined ? localData.data : null
    }
  }

  /**
   * 设置数据 - 本地存储
   * @param {string} key 数据键
   * @param {*} data 数据
   * @param {Object} options 选项
   */
  async setData(key, data, options = {}) {
    console.log(`[StorageManager] 开始设置数据: ${key}`)

    try {
      const now = Date.now()
      const version = this.getNextVersion(key)
      
      const storageData = {
        data: data,
        meta: {
          lastModified: now,
          version: version
        }
      }

      // L1本地存储
      wx.setStorageSync(key, storageData)
      
      // L2内存缓存
      this.setMemoryCache(key, data)
      
      console.log(`[StorageManager] 数据已保存到本地: ${key}`)

    } catch (error) {
      console.error(`[StorageManager] 设置数据失败: ${key}`, error)
      throw error
    }
  }

  /**
   * 删除数据
   * @param {string} key 数据键
   */
  async deleteData(key) {
    try {
      // 删除本地存储
      wx.removeStorageSync(key)
      
      // 删除内存缓存
      this.memoryCache.delete(key)
      
      console.log(`[StorageManager] 数据已删除: ${key}`)
    } catch (error) {
      console.error(`[StorageManager] 删除数据失败: ${key}`, error)
      throw error
    }
  }

  /**
   * 获取本地数据
   * @param {string} key 数据键
   * @returns {Object|null} 本地数据
   */
  getLocalData(key) {
    try {
      const data = wx.getStorageSync(key)
      
      // 检查数据结构是否完整
      if (data) {
        // 如果是旧格式数据（直接数组），转换为新格式
        if (Array.isArray(data)) {
          const newFormat = {
            data: data,
            meta: {
              lastModified: Date.now(),
              version: 1
            }
          }
          
          // 保存新格式
          wx.setStorageSync(key, newFormat)
          return newFormat
        }
        
        // 检查新格式数据的完整性
        if (data.data !== undefined) {
          // 确保 meta 对象存在
          if (!data.meta) {
            data.meta = {
              lastModified: Date.now(),
              version: 1
            }
            wx.setStorageSync(key, data)
          }
          return data
        }
      }
      
      return null
    } catch (error) {
      console.error(`[StorageManager] 获取本地数据失败: ${key}`, error)
      return null
    }
  }

  /**
   * 设置内存缓存
   * @param {string} key 数据键
   * @param {*} data 数据
   */
  setMemoryCache(key, data) {
    this.memoryCache.set(key, {
      data: data,
      timestamp: Date.now()
    })
    
    // 内存缓存大小控制（最多100项）
    if (this.memoryCache.size > 100) {
      const firstKey = this.memoryCache.keys().next().value
      this.memoryCache.delete(firstKey)
    }
  }


  /**
   * 获取下一个版本号
   * @param {string} key 数据键
   * @returns {number} 版本号
   */
  getNextVersion(key) {
    const localData = this.getLocalData(key)
    return localData ? (localData.meta.version + 1) : 1
  }

  /**
   * 获取存储统计信息
   * @returns {Object} 统计信息
   */
  getStorageStats() {
    try {
      const info = wx.getStorageInfoSync()
      return {
        keys: info.keys,
        currentSize: info.currentSize,
        limitSize: info.limitSize,
        memoryCacheSize: this.memoryCache.size
      }
    } catch (error) {
      console.error('[StorageManager] 获取存储统计失败', error)
      return null
    }
  }

  /**
   * 清理过期缓存
   * @param {number} maxAge 最大缓存时间（毫秒）
   */
  cleanExpiredCache(maxAge = 24 * 60 * 60 * 1000) { // 默认24小时
    const now = Date.now()
    
    // 清理内存缓存
    for (const [key, value] of this.memoryCache.entries()) {
      if (now - value.timestamp > maxAge) {
        this.memoryCache.delete(key)
      }
    }
    
    console.log(`[StorageManager] 已清理过期缓存，当前内存缓存: ${this.memoryCache.size}项`)
  }
}

// 单例模式
let storageManagerInstance = null

/**
 * 获取存储管理器实例
 * @returns {StorageManager} 存储管理器实例
 */
function getStorageManager() {
  if (!storageManagerInstance) {
    storageManagerInstance = new StorageManager()
  }
  return storageManagerInstance
}

module.exports = {
  StorageManager,
  getStorageManager
}
