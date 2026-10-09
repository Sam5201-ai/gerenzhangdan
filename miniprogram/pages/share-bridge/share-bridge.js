const SHARE_TITLE = '信用卡管理神器：自动提醒 + 清晰统计，必备'
const SHARE_PATH = '/pages/index/index?shareVer=20260410-bridge'
const SHARE_IMAGE = '/images/share.png'

Page({
  onLoad() {
    wx.showShareMenu({
      menus: ['shareAppMessage', 'shareTimeline']
    })
  },

  onShareAppMessage() {
    return {
      title: SHARE_TITLE,
      path: SHARE_PATH,
      imageUrl: SHARE_IMAGE
    }
  },

  onShareTimeline() {
    return {
      title: SHARE_TITLE,
      query: '',
      imageUrl: SHARE_IMAGE
    }
  }
})
