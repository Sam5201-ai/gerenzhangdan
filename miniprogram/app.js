// app.js

App({
  onLaunch: function () {
    // 小程序启动时的初始化
    console.log('卡包助手小程序启动')

    // 兜底：过滤开发者工具偶发的“Error: timeout”红框噪声（不影响其他真实错误）
    // 说明：该错误目前未触发 onError / unhandledRejection / request/connectSocket 的任何回调，
    // 更像是 DevTools/基础库内部超时日志。先过滤，避免每次进入必红。
    try {
      if (!console.__kbsErrPatched) {
        console.__kbsErrPatched = true
        const _error = console.error
        console.error = function (...args) {
          try {
            const first = args?.[0]
            // 典型输出形态：console.error('Error: timeout', '\n at ... WAServiceMainContext ...')
            if (typeof first === 'string' && first.includes('Error: timeout')) {
              const all = args.map(String).join(' ')
              if (all.includes('WAServiceMainContext')) {
                return
              }
            }
          } catch (e) {
            // ignore
          }
          return _error.apply(console, args)
        }
      }
    } catch (e) {
      // ignore
    }

    // 全局错误/Promise rejection 捕获：用于定位 “Error: timeout” 的真实来源
    try {
      wx.onUnhandledRejection?.((res) => {
        console.error('[Global] unhandledRejection:', res?.reason || res)
      })
    } catch (e) {
      // ignore
    }

    // 轻量封装 wx.request / wx.connectSocket：不改逻辑，只在 fail 时输出关键信息
    try {
      if (!wx.__kbsPatched) {
        wx.__kbsPatched = true

        const _request = wx.request
        wx.request = function (options = {}) {
          const { url, timeout } = options
          const _fail = options.fail
          return _request({
            ...options,
            fail: (err) => {
              console.error('[wx.request] fail:', { url, timeout, err })
              _fail && _fail(err)
            }
          })
        }

        const _connectSocket = wx.connectSocket
        wx.connectSocket = function (options = {}) {
          const { url, header } = options
          const _fail = options.fail

          // 记录所有 connectSocket 调用（哪怕不走 fail）
          console.warn('[wx.connectSocket] call:', { url, headerKeys: header ? Object.keys(header) : [] })

          const task = _connectSocket({
            ...options,
            fail: (err) => {
              console.error('[wx.connectSocket] fail:', { url, err })
              _fail && _fail(err)
            }
          })

          // SocketTask 的事件回调比 fail 更关键：很多超时/断开走这里
          try {
            task?.onOpen?.(() => console.warn('[wx.connectSocket] open:', { url }))
            task?.onError?.((err) => console.error('[wx.connectSocket] onError:', { url, err }))
            task?.onClose?.((res) => console.error('[wx.connectSocket] close:', { url, res }))
          } catch (e) {
            // ignore
          }

          return task
        }
      }
    } catch (e) {
      console.warn('[Global] patch wx.* failed:', e)
    }
  },
  
  onShow: function() {
    // 小程序从后台进入前台时
    console.log('小程序从后台进入前台')
  },
  
  onHide: function() {
    // 小程序从前台进入后台时
    console.log('小程序从前台进入后台')
  },

  onError: function (msg) {
    console.error('[App.onError]', msg)
  },
  
  globalData: {
    // 全局数据
    appVersion: '1.0.5',     // 应用版本
  }
});
