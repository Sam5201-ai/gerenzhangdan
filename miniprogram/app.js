// app.js

App({
  onLaunch: function () {
    // 小程序启动时的初始化
    console.log('卡包助手小程序启动')
  },
  
  onShow: function() {
    // 小程序从后台进入前台时
    console.log('小程序从后台进入前台')
  },
  
  onHide: function() {
    // 小程序从前台进入后台时
    console.log('小程序从前台进入后台')
  },
  
  globalData: {
    // 全局数据
    appVersion: '1.0.0',     // 应用版本
  }
});
