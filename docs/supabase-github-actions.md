# Supabase 自动部署（GitHub Actions）

已配置工作流：`.github/workflows/supabase-deploy.yml`

## 会自动做什么

- `supabase db push`：部署 `supabase/migrations` 下的数据库变更
- `supabase functions deploy`：部署 `supabase/functions` 下所有 Edge Functions
- （可选）`supabase secrets set`：同步函数运行时密钥

## 触发方式

- 推送到 `main` / `master`，且变更路径命中 `supabase/**`
- 手动触发：GitHub Actions -> `Deploy Supabase` -> `Run workflow`

## 本次新增的数据表与能力

本次为了支持微信小程序订阅消息还款提醒，新增了以下数据库结构与服务端能力：

- `public.user_subscription_settings`
  - 记录用户是否启用“还款提醒”
  - 记录用户剩余可接收次数 `repayment_reminder_count`
- `public.repayment_reminder_logs`
  - 记录每天每个分期账单的提醒发送日志
  - 通过唯一约束 `(bill_id, reminder_date)` 保证“同一个分期账单，一天只触发一次”
- `supabase/functions/data/index.ts`
  - 新增订阅设置读取/保存接口
  - 新增续收 `+1` 接口
  - 新增还款提醒派发接口 `subscriptions.dispatchRepaymentReminders`

## 你需要在 GitHub 仓库配置的 Secrets

### 必填

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_ID`（你的项目是：`yggtdyohiqlegdneshyx`）

### 建议填写（用于自动同步函数密钥）

- `WECHAT_APPID`（你的小程序 appid）
- `WECHAT_SECRET`（你的小程序 secret）
- `APP_JWT_SECRET`（自定义随机强密钥）
- `KBS_CRON_SECRET`（用于保护定时触发还款提醒的请求）

## 定时方案（你本次选择的是 Supabase 侧定时任务）

建议在 Supabase 后台将定时任务配置为每天北京时间上午 8 点调用 `data` 函数，并带上：

- 请求头：`x-cron-secret: <KBS_CRON_SECRET>`
- 请求体：

```json
{
  "action": "subscriptions.dispatchRepaymentReminders",
  "payload": {
    "page": "pages/installments/installments"
  }
}
```

提醒规则已按以下逻辑实现：

- 只有用户在消息订阅中启用了还款提醒，且 `repayment_reminder_count > 0` 才会触发
- 提醒时间固定为还款日当天上午 8 点
- 如果多个账单的下次还款日期相同，则每张卡片对应的分期账单各提醒一次
- 同一个分期账单同一天只允许发送一次提醒
- 每成功发送一次，自动扣减 1 次可接收次数

## 获取方式

- `SUPABASE_ACCESS_TOKEN`：Supabase Dashboard -> Account -> Access Tokens
- `SUPABASE_DB_PASSWORD`：创建项目时设置的数据库密码（不是 API key）
- `SUPABASE_PROJECT_ID`：项目 URL 里的 ref（`https://<ref>.supabase.co`）

## 注意

- `sb_publishable_...` 这种 publishable key 不等于 `SUPABASE_DB_PASSWORD`
- 如果数据库密码忘了，可在 Supabase 重置 DB password 后同步更新 GitHub Secret
- `KBS_CRON_SECRET` 需要同时配置到工作流密钥与 Supabase Functions Secrets 中
