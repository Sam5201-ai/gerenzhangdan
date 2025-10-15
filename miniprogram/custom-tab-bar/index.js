Component({
  data: {
    selected: 0,
    color: "#9ca3af",
    selectedColor: "#8b5cf6",
    hidden: false,
    list: [
      {
        pagePath: "pages/index/index",
        text: "卡包",
        iconPath: "/images/card.svg",
        selectedIconPath: "/images/card-active.svg"
      },
      {
        pagePath: "pages/installments/installments",
        text: "分期",
        iconPath: "/images/calendar.svg",
        selectedIconPath: "/images/calendar-active.svg"
      },
      {
        pagePath: "pages/settings/settings",
        text: "我的",
        iconPath: "/images/user.svg",
        selectedIconPath: "/images/user-active.svg"
      }
    ]
  },
  attached() {
  },
  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset
      const url = '/' + data.path
      wx.switchTab({url})
      this.setData({
        selected: data.index
      })
    }
  }
})