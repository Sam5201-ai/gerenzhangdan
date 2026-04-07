/**
 * 用户管理器 - 处理用户信息管理
 * 功能：本地用户信息存储 + 云端(openid) 登录与同步
 */

const { getCloudApi } = require('./CloudApi.js')

class UserManager {
  constructor() {
    this.userInfo = null
    this.cloudApi = getCloudApi()
  }

  /**
   * 初始化用户管理器
   */
  async init() {
    try {
      console.log('[UserManager] 初始化用户管理器')
      
      // 加载本地用户信息
      const localUserInfo = this.getLocalUserInfo()
      if (localUserInfo) {
        this.userInfo = localUserInfo
        console.log('[UserManager] 加载本地用户信息')
      } else {
        // 创建新的本地用户信息
        const now = Date.now()
        const userId = this.generateLocalUserId()
        this.userInfo = {
          userId: userId,
          createdAt: now,
          updatedAt: now
        }
        this.saveUserInfo(this.userInfo)
        console.log('[UserManager] 创建新用户信息')
      }

      // 云端登录：拿到 openid，并将 userId 统一为 openid（用于多端同步）
      // 说明：即使云端失败，也不影响本地使用
      try {
        const nickname = this.userInfo?.nickName || ''
        const auth = await this.cloudApi.login({ nickname })
        if (auth?.openid) {
          const now = Date.now()
          this.userInfo = {
            ...this.userInfo,
            userId: auth.openid,
            openid: auth.openid,
            updatedAt: now,
            lastLoginAt: now
          }
          this.saveUserInfo(this.userInfo)
          console.log('[UserManager] 云端登录成功(openid)')
        }
      } catch (e) {
        console.warn('[UserManager] 云端登录失败，继续使用本地模式：', e)
      }
      
    } catch (error) {
      console.error('[UserManager] 初始化失败', error)
    }
  }

  /**
   * 生成本地用户ID
   */
  generateLocalUserId() {
    return 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
  }

  /**
   * 获取当前用户信息
   * @returns {Object|null} 用户信息
   */
  getUserInfo() {
    return this.userInfo
  }

  /**
   * 获取用户ID
   * @returns {string|null} 用户ID
   */
  getUserId() {
    return this.userInfo?.userId || null
  }

  /**
   * 获取 openid（若已云端登录）
   */
  getOpenId() {
    return this.userInfo?.openid || null
  }

  /**
   * 保存用户信息到本地
   * @param {Object} userInfo 用户信息
   */
  saveUserInfo(userInfo) {
    try {
      wx.setStorageSync('userInfo', userInfo)
      
      console.log('[UserManager] 用户信息已保存到本地')
    } catch (error) {
      console.error('[UserManager] 保存用户信息失败', error)
    }
  }

  /**
   * 从本地获取用户信息
   * @returns {Object|null} 用户信息
   */
  getLocalUserInfo() {
    try {
      const userInfo = wx.getStorageSync('userInfo')
      if (userInfo && userInfo.userId) {
        return userInfo
      }
      
      return null
    } catch (error) {
      console.error('[UserManager] 获取本地用户信息失败', error)
      return null
    }
  }

  /**
   * 清除用户数据
   */
  clearUserData() {
    try {
      // 清除用户信息
      this.userInfo = null
      // 清除云端登录态
      try {
        this.cloudApi.clearAuth()
      } catch (e) {
        // ignore
      }
      
      // 清除本地存储
      wx.removeStorageSync('userInfo')
      
      console.log('[UserManager] 用户数据已清除')
      
      wx.showToast({
        title: '数据已清除',
        icon: 'success'
      })
      
    } catch (error) {
      console.error('[UserManager] 清除用户数据失败', error)
    }
  }
}

// 单例模式
let userManagerInstance = null

/**
 * 获取用户管理器实例
 * @returns {UserManager} 用户管理器实例
 */
function getUserManager() {
  if (!userManagerInstance) {
    userManagerInstance = new UserManager()
  }
  return userManagerInstance
}

module.exports = {
  UserManager,
  getUserManager
}