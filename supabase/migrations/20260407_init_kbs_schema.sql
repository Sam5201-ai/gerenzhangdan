-- 卡帮手 plus - Supabase schema (2026-04-07)
-- 说明：
-- - 本方案采用 Edge Function + Service Role 访问数据库，不依赖 Supabase Auth/RLS 做用户隔离
-- - 用户唯一标识使用微信 openid
-- - created_at / updated_at 使用 timestamptz

create extension if not exists pgcrypto;

-- 用户表：记录昵称、openid、创建时间、更新时间、最近一次登录时间
create table if not exists public.app_users (
  openid text primary key,
  nickname text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- 信用卡表：记录用户所创建的所有信用卡信息
create table if not exists public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  openid text not null references public.app_users(openid) on delete cascade,
  name text not null,
  card_number text not null,
  card_limit numeric,
  due_day int not null check (due_day between 1 and 31),
  style text,
  reminder_enabled boolean not null default false,
  reminder_days int not null default 3,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_credit_cards_openid on public.credit_cards(openid);

-- 分期账单信息
create table if not exists public.installment_bills (
  id uuid primary key default gen_random_uuid(),
  openid text not null references public.app_users(openid) on delete cascade,
  card_id uuid references public.credit_cards(id) on delete set null,
  card_name text,
  total_amount numeric not null default 0,
  installment_count int not null default 0,
  per_payment_amount numeric not null default 0,
  payment_day int not null default 15 check (payment_day between 1 and 31),
  paid_installments int not null default 0,
  remaining_installments int not null default 0,
  paid_amount numeric not null default 0,
  remaining_amount numeric not null default 0,
  last_payment_date date,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_installment_bills_openid on public.installment_bills(openid);
create index if not exists idx_installment_bills_card_id on public.installment_bills(card_id);

-- 还款记录明细
create table if not exists public.repayment_records (
  id uuid primary key default gen_random_uuid(),
  openid text not null references public.app_users(openid) on delete cascade,
  card_id uuid references public.credit_cards(id) on delete set null,
  bill_id uuid references public.installment_bills(id) on delete set null,
  card_name text,
  amount numeric not null default 0,
  payment_date date not null,
  remaining_periods int,
  created_at timestamptz not null default now()
);
create index if not exists idx_repayment_records_openid on public.repayment_records(openid);
create index if not exists idx_repayment_records_bill_id on public.repayment_records(bill_id);

-- 自动更新时间戳
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_app_users_updated_at on public.app_users;
create trigger trg_app_users_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

drop trigger if exists trg_credit_cards_updated_at on public.credit_cards;
create trigger trg_credit_cards_updated_at
before update on public.credit_cards
for each row execute function public.set_updated_at();

drop trigger if exists trg_installment_bills_updated_at on public.installment_bills;
create trigger trg_installment_bills_updated_at
before update on public.installment_bills
for each row execute function public.set_updated_at();

