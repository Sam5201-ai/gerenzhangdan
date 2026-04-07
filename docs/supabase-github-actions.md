# Supabase 自动部署（GitHub Actions）

已配置工作流：`.github/workflows/supabase-deploy.yml`

## 会自动做什么

- `supabase db push`：部署 `supabase/migrations` 下的数据库变更
- `supabase functions deploy`：部署 `supabase/functions` 下所有 Edge Functions
- （可选）`supabase secrets set`：同步函数运行时密钥

## 触发方式

- 推送到 `main` / `master`，且变更路径命中 `supabase/**`
- 手动触发：GitHub Actions -> `Deploy Supabase` -> `Run workflow`

## 你需要在 GitHub 仓库配置的 Secrets

### 必填

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_ID`（你的项目是：`yggtdyohiqlegdneshyx`）

### 建议填写（用于自动同步函数密钥）

- `WECHAT_APPID`（你的小程序 appid）
- `WECHAT_SECRET`（你的小程序 secret）
- `APP_JWT_SECRET`（自定义随机强密钥）

## 获取方式

- `SUPABASE_ACCESS_TOKEN`：Supabase Dashboard -> Account -> Access Tokens
- `SUPABASE_DB_PASSWORD`：创建项目时设置的数据库密码（不是 API key）
- `SUPABASE_PROJECT_ID`：项目 URL 里的 ref（`https://<ref>.supabase.co`）

## 注意

- `sb_publishable_...` 这种 publishable key 不等于 `SUPABASE_DB_PASSWORD`
- 如果数据库密码忘了，可在 Supabase 重置 DB password 后同步更新 GitHub Secret

