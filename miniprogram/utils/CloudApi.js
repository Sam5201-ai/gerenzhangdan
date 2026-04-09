/**
 * CloudApi - 通过 Supabase Edge Functions 实现云端存储与多端同步
 * 设计：
 * - wx-login：用 wx.login(code) 换 openid，并签发 x-kbs-token（自签 JWT）
 * - data：所有 CRUD 走该函数（Service Role），按 openid 隔离
 */

const SUPABASE_PROJECT_URL = 'https://yggtdyohiqlegdneshyx.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_UrSrFRDu7bi6-0ylWw3_jA_0Clk39SG'
const REPAYMENT_REMINDER_TEMPLATE_ID = '5r9EsCSn8mNe4HhDGIotDLMHus50Cb-5XfJA7Y0ZgL4'

const FUNCTIONS_BASE = `${SUPABASE_PROJECT_URL}/functions/v1`
const STORAGE_KEY = 'cloudAuth'

function requestJson(url, { method = 'POST', headers = {}, data = {} } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      header: {
        // Supabase Functions 必需
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'content-type': 'application/json',
        ...headers
      },
      data,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(res.data)}`))
        }
      },
      fail: (err) => reject(err)
    })
  })
}

class CloudApi {
  getAuth() {
    try {
      return wx.getStorageSync(STORAGE_KEY) || null
    } catch {
      return null
    }
  }

  setAuth(auth) {
    try {
      wx.setStorageSync(STORAGE_KEY, auth)
    } catch (e) {
      console.warn('[CloudApi] setAuth failed', e)
    }
  }

  clearAuth() {
    try {
      wx.removeStorageSync(STORAGE_KEY)
    } catch (e) {
      console.warn('[CloudApi] clearAuth failed', e)
    }
  }

  isEnabled() {
    const auth = this.getAuth()
    return !!(auth && auth.openid && auth.token)
  }

  async login({ nickname } = {}) {
    const code = await new Promise((resolve, reject) => {
      wx.login({
        success: (res) => resolve(res.code),
        fail: reject
      })
    })

    const resp = await requestJson(`${FUNCTIONS_BASE}/wx-login`, {
      data: { code, nickname: nickname || '' }
    })

    if (!resp || !resp.openid || !resp.token) {
      throw new Error('云端登录失败：返回数据不完整')
    }

    const auth = {
      openid: resp.openid,
      token: resp.token,
      loginAt: Date.now()
    }
    this.setAuth(auth)
    return auth
  }

  async call(action, payload = {}) {
    const auth = this.getAuth()
    if (!auth || !auth.token) {
      throw new Error('未登录云端（缺少 token）')
    }
    return await requestJson(`${FUNCTIONS_BASE}/data`, {
      headers: {
        'x-kbs-token': auth.token
      },
      data: { action, payload }
    })
  }

  async getReminderSettings() {
    const resp = await this.call('subscriptions.getSettings')
    return resp?.data || null
  }

  async saveReminderSettings(settings = {}) {
    const resp = await this.call('subscriptions.saveSettings', settings)
    return resp?.data || null
  }

  async requestRepaymentReminderSubscription() {
    return await new Promise((resolve, reject) => {
      wx.requestSubscribeMessage({
        tmplIds: [REPAYMENT_REMINDER_TEMPLATE_ID],
        success: (res) => resolve(res),
        fail: (error) => reject(error)
      })
    })
  }

  async renewReminderSubscription({ templateId = REPAYMENT_REMINDER_TEMPLATE_ID, scene = 'repayment_reminder' } = {}) {
    const resp = await this.call('subscriptions.renew', {
      templateId,
      scene
    })
    return resp?.data || null
  }
}

let instance = null
function getCloudApi() {
  if (!instance) instance = new CloudApi()
  return instance
}

module.exports = {
  CloudApi,
  getCloudApi,
  REPAYMENT_REMINDER_TEMPLATE_ID
}

