// Supabase Edge Function: data
// 用途：小程序通过此函数进行 CRUD（由 Service Role 访问 DB），并用 APP_JWT_SECRET 校验 openid 归属
//
// Header:
// - apikey / authorization: Supabase Function 调用所需（小程序用 anon publishable key）
// - x-kbs-token: 我们自签的 app token
//
// Body:
// { action: string, payload?: any }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { jwtVerify } from "https://esm.sh/jose@5.9.6";

type AppUserRow = {
  openid: string;
  nickname: string | null;
};

type ReminderSettingsRow = {
  openid: string;
  repayment_reminder_enabled: boolean;
  repayment_reminder_count: number;
  created_at?: string;
  updated_at?: string;
};

type ReminderCandidate = {
  id: string;
  openid: string;
  card_id: string | null;
  card_name: string | null;
  per_payment_amount: number | string | null;
  payment_day: number;
  installment_count: number;
  paid_installments: number;
  status: string;
};

const REPAYMENT_TEMPLATE_ID = "5r9EsCSn8mNe4HhDGIotDLMHus50Cb-5XfJA7Y0ZgL4";
const REMINDER_SCENE = "repayment_reminder";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type, x-kbs-token",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function toDateString(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLocalDateInChina(date = new Date()) {
  const chinaString = date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  return new Date(chinaString.replace(" ", "T"));
}

function formatReminderTime(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day} 08:00`;
}

function normalizeAmount(value: number | string | null | undefined) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function isBillActive(bill: ReminderCandidate) {
  return Number(bill.paid_installments || 0) < Number(bill.installment_count || 0) && bill.status !== "completed";
}

async function requireOpenId(req: Request): Promise<string> {
  const APP_JWT_SECRET = Deno.env.get("APP_JWT_SECRET")!;
  if (!APP_JWT_SECRET) throw new Error("Missing APP_JWT_SECRET");
  const token = req.headers.get("x-kbs-token") || "";
  if (!token) throw new Error("Missing token");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(APP_JWT_SECRET));
  const openid = (payload as any)?.openid;
  if (!openid || typeof openid !== "string") throw new Error("Invalid token");
  return openid;
}

async function ensureReminderSettings(supabase: ReturnType<typeof createClient>, openid: string) {
  const { data, error } = await supabase
    .from("user_subscription_settings")
    .upsert({ openid }, { onConflict: "openid" })
    .select("openid, repayment_reminder_enabled, repayment_reminder_count, created_at, updated_at")
    .single<ReminderSettingsRow>();

  if (error) throw error;
  return data;
}

async function getWechatAccessToken() {
  const WECHAT_APPID = Deno.env.get("WECHAT_APPID") || "";
  const WECHAT_SECRET = Deno.env.get("WECHAT_SECRET") || "";
  if (!WECHAT_APPID || !WECHAT_SECRET) {
    throw new Error("Missing WECHAT_APPID or WECHAT_SECRET");
  }

  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(WECHAT_APPID)}` +
    `&secret=${encodeURIComponent(WECHAT_SECRET)}`;

  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(`get access_token failed: ${JSON.stringify(payload)}`);
  }
  return payload.access_token as string;
}

async function sendWechatSubscribeMessage({
  accessToken,
  touser,
  page,
  data,
}: {
  accessToken: string;
  touser: string;
  page: string;
  data: Record<string, { value: string }>;
}) {
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      touser,
      template_id: REPAYMENT_TEMPLATE_ID,
      page,
      data,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload?.errcode) {
    throw new Error(`send subscribe message failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Missing server env" }, 500);

  let body: { action?: string; payload?: any } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = (body.action || "").trim();
  if (!action) return json({ error: "Missing action" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const payload = body.payload ?? {};
  const isCronAction = action === "subscriptions.dispatchRepaymentReminders";

  let openid = "";
  if (!isCronAction) {
    try {
      openid = await requireOpenId(req);
    } catch (e) {
      return json({ error: "Unauthorized", detail: String(e) }, 401);
    }
  } else {
    const cronSecret = Deno.env.get("SUPABASE_CRON_SECRET") || "";
    const requestSecret = req.headers.get("x-cron-secret") || "";
    if (!cronSecret || requestSecret !== cronSecret) {
      return json({ error: "Unauthorized cron request" }, 401);
    }
  }

  // user profile
  if (action === "user.profile") {
    const { data, error } = await supabase
      .from("app_users")
      .select("openid,nickname,created_at,updated_at,last_login_at")
      .eq("openid", openid)
      .maybeSingle();
    if (error) return json({ error: "user.profile failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "user.updateProfile") {
    const nickname = String(payload?.nickname ?? "").trim();
    if (!nickname) return json({ error: "Missing nickname" }, 400);
    const { data, error } = await supabase
      .from("app_users")
      .update({ nickname })
      .eq("openid", openid)
      .select("openid,nickname,created_at,updated_at,last_login_at")
      .single();
    if (error) return json({ error: "user.updateProfile failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "subscriptions.getSettings") {
    try {
      const data = await ensureReminderSettings(supabase, openid);
      return json({ data }, 200);
    } catch (error) {
      return json({ error: "subscriptions.getSettings failed", detail: error }, 500);
    }
  }

  if (action === "subscriptions.saveSettings") {
    const repaymentReminderEnabled = Boolean(payload?.repaymentReminderEnabled);
    try {
      const { data, error } = await supabase
        .from("user_subscription_settings")
        .upsert(
          {
            openid,
            repayment_reminder_enabled: repaymentReminderEnabled,
          },
          { onConflict: "openid" },
        )
        .select("openid, repayment_reminder_enabled, repayment_reminder_count, created_at, updated_at")
        .single<ReminderSettingsRow>();
      if (error) return json({ error: "subscriptions.saveSettings failed", detail: error }, 500);
      return json({ data }, 200);
    } catch (error) {
      return json({ error: "subscriptions.saveSettings failed", detail: error }, 500);
    }
  }

  if (action === "subscriptions.renew") {
    const templateId = String(payload?.templateId || "").trim();
    const scene = String(payload?.scene || "").trim();
    if (templateId !== REPAYMENT_TEMPLATE_ID || scene !== REMINDER_SCENE) {
      return json({ error: "Invalid subscription scene" }, 400);
    }

    const { data, error } = await supabase
      .from("user_subscription_settings")
      .upsert({ openid }, { onConflict: "openid" })
      .select("openid, repayment_reminder_enabled, repayment_reminder_count, created_at, updated_at")
      .single<ReminderSettingsRow>();
    if (error) return json({ error: "subscriptions.renew init failed", detail: error }, 500);

    const currentCount = Number(data?.repayment_reminder_count || 0);
    const { data: updated, error: updateError } = await supabase
      .from("user_subscription_settings")
      .update({
        repayment_reminder_count: currentCount + 1,
      })
      .eq("openid", openid)
      .select("openid, repayment_reminder_enabled, repayment_reminder_count, created_at, updated_at")
      .single<ReminderSettingsRow>();

    if (updateError) return json({ error: "subscriptions.renew failed", detail: updateError }, 500);
    return json({ data: updated }, 200);
  }

  if (action === "subscriptions.dispatchRepaymentReminders") {
    const dispatchDate = payload?.date ? new Date(`${String(payload.date)}T08:00:00+08:00`) : getLocalDateInChina();
    const today = toDateString(dispatchDate);
    const page = String(payload?.page || "pages/installments/installments");

    const { data: settingsRows, error: settingsError } = await supabase
      .from("user_subscription_settings")
      .select("openid, repayment_reminder_enabled, repayment_reminder_count")
      .eq("repayment_reminder_enabled", true)
      .gt("repayment_reminder_count", 0);
    if (settingsError) return json({ error: "subscriptions.dispatchRepaymentReminders settings failed", detail: settingsError }, 500);

    const openids = (settingsRows || []).map((item: ReminderSettingsRow) => item.openid);
    if (openids.length === 0) {
      return json({ data: { sent: 0, skipped: 0, today } }, 200);
    }

    const { data: bills, error: billsError } = await supabase
      .from("installment_bills")
      .select("id, openid, card_id, card_name, per_payment_amount, payment_day, installment_count, paid_installments, status")
      .in("openid", openids)
      .eq("payment_day", dispatchDate.getDate());
    if (billsError) return json({ error: "subscriptions.dispatchRepaymentReminders bills failed", detail: billsError }, 500);

    const activeBills = (bills || []).filter((bill: ReminderCandidate) => isBillActive(bill));
    if (activeBills.length === 0) {
      return json({ data: { sent: 0, skipped: 0, today } }, 200);
    }

    const billIds = activeBills.map((bill: ReminderCandidate) => bill.id);
    const { data: sentLogs, error: logsError } = await supabase
      .from("repayment_reminder_logs")
      .select("bill_id")
      .eq("reminder_date", today)
      .in("bill_id", billIds);
    if (logsError) return json({ error: "subscriptions.dispatchRepaymentReminders logs failed", detail: logsError }, 500);

    const sentBillIds = new Set((sentLogs || []).map((item: { bill_id: string }) => item.bill_id));
    const pendingBills = activeBills.filter((bill: ReminderCandidate) => !sentBillIds.has(bill.id));
    if (pendingBills.length === 0) {
      return json({ data: { sent: 0, skipped: activeBills.length, today } }, 200);
    }

    const { data: users, error: usersError } = await supabase
      .from("app_users")
      .select("openid, nickname")
      .in("openid", openids);
    if (usersError) return json({ error: "subscriptions.dispatchRepaymentReminders users failed", detail: usersError }, 500);

    const userMap = new Map((users || []).map((user: AppUserRow) => [user.openid, user]));
    const settingsMap = new Map((settingsRows || []).map((item: ReminderSettingsRow) => [item.openid, item]));

    let accessToken = "";
    try {
      accessToken = await getWechatAccessToken();
    } catch (error) {
      return json({ error: "subscriptions.dispatchRepaymentReminders token failed", detail: error }, 500);
    }

    let sent = 0;
    let skipped = activeBills.length - pendingBills.length;
    const failures: Array<{ billId: string; openid: string; reason: string }> = [];

    for (const bill of pendingBills) {
      const user = userMap.get(bill.openid);
      const setting = settingsMap.get(bill.openid);
      const remainingCount = Number(setting?.repayment_reminder_count || 0);

      if (!user || remainingCount <= 0) {
        skipped += 1;
        continue;
      }

      try {
        await sendWechatSubscribeMessage({
          accessToken,
          touser: bill.openid,
          page,
          data: {
            thing1: { value: String(bill.card_name || "信用卡") },
            thing2: { value: "信用卡" },
            time3: { value: formatReminderTime(dispatchDate) },
            amount4: { value: normalizeAmount(bill.per_payment_amount) },
          },
        });

        const { error: logError } = await supabase.from("repayment_reminder_logs").insert({
          openid: bill.openid,
          bill_id: bill.id,
          card_id: bill.card_id,
          template_id: REPAYMENT_TEMPLATE_ID,
          reminder_date: today,
          scheduled_at: `${today} 08:00:00+08`,
          status: "sent",
        });
        if (logError) throw logError;

        const { error: decrementError } = await supabase
          .from("user_subscription_settings")
          .update({
            repayment_reminder_count: Math.max(remainingCount - 1, 0),
          })
          .eq("openid", bill.openid);
        if (decrementError) throw decrementError;

        settingsMap.set(bill.openid, {
          ...(setting as ReminderSettingsRow),
          openid: bill.openid,
          repayment_reminder_enabled: Boolean(setting?.repayment_reminder_enabled),
          repayment_reminder_count: Math.max(remainingCount - 1, 0),
        });
        sent += 1;
      } catch (error) {
        failures.push({
          billId: bill.id,
          openid: bill.openid,
          reason: String(error),
        });
        await supabase.from("repayment_reminder_logs").insert({
          openid: bill.openid,
          bill_id: bill.id,
          card_id: bill.card_id,
          template_id: REPAYMENT_TEMPLATE_ID,
          reminder_date: today,
          scheduled_at: `${today} 08:00:00+08`,
          status: "failed",
          failure_reason: String(error).slice(0, 500),
        });
      }
    }

    return json({
      data: {
        today,
        sent,
        skipped,
        failures,
      },
    }, 200);
  }

  // cards
  if (action === "cards.list") {
    const { data, error } = await supabase
      .from("credit_cards")
      .select("*")
      .eq("openid", openid)
      .order("created_at", { ascending: true });
    if (error) return json({ error: "cards.list failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "cards.upsert") {
    const card = payload?.card || {};
    if (!card?.name || !card?.card_number || !card?.due_day) {
      return json({ error: "Missing card fields" }, 400);
    }
    const row = {
      id: card.id ?? undefined,
      openid,
      name: String(card.name),
      card_number: String(card.card_number),
      card_limit: card.card_limit ?? null,
      due_day: Number(card.due_day),
      style: card.style ?? null,
      reminder_enabled: Boolean(card.reminder_enabled ?? false),
      reminder_days: Number(card.reminder_days ?? 3),
    };
    const { data, error } = await supabase.from("credit_cards").upsert(row).select("*").single();
    if (error) return json({ error: "cards.upsert failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "cards.delete") {
    const id = payload?.id;
    if (!id) return json({ error: "Missing id" }, 400);
    const { error } = await supabase.from("credit_cards").delete().eq("openid", openid).eq("id", id);
    if (error) return json({ error: "cards.delete failed", detail: error }, 500);
    return json({ ok: true }, 200);
  }

  // bills
  if (action === "bills.list") {
    const { data, error } = await supabase
      .from("installment_bills")
      .select("*")
      .eq("openid", openid)
      .order("created_at", { ascending: true });
    if (error) return json({ error: "bills.list failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "bills.upsert") {
    const bill = payload?.bill || {};
    const row = {
      id: bill.id ?? undefined,
      openid,
      card_id: bill.card_id ?? null,
      card_name: bill.card_name ?? null,
      total_amount: bill.total_amount ?? 0,
      installment_count: Number(bill.installment_count ?? 0),
      per_payment_amount: bill.per_payment_amount ?? 0,
      payment_day: Number(bill.payment_day ?? 15),
      paid_installments: Number(bill.paid_installments ?? 0),
      remaining_installments: Number(bill.remaining_installments ?? 0),
      paid_amount: bill.paid_amount ?? 0,
      remaining_amount: bill.remaining_amount ?? 0,
      last_payment_date: bill.last_payment_date ?? null,
      status: bill.status ?? "active",
    };
    const { data, error } = await supabase.from("installment_bills").upsert(row).select("*").single();
    if (error) return json({ error: "bills.upsert failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "bills.delete") {
    const id = payload?.id;
    if (!id) return json({ error: "Missing id" }, 400);
    const { error } = await supabase.from("installment_bills").delete().eq("openid", openid).eq("id", id);
    if (error) return json({ error: "bills.delete failed", detail: error }, 500);
    return json({ ok: true }, 200);
  }

  // repayment records
  if (action === "repayments.list") {
    const { data, error } = await supabase
      .from("repayment_records")
      .select("*")
      .eq("openid", openid)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) return json({ error: "repayments.list failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "repayments.add") {
    const r = payload?.record || {};
    if (!r?.payment_date) return json({ error: "Missing payment_date" }, 400);
    const row = {
      openid,
      card_id: r.card_id ?? null,
      bill_id: r.bill_id ?? null,
      card_name: r.card_name ?? null,
      amount: r.amount ?? 0,
      payment_date: r.payment_date,
    };
    const { data, error } = await supabase.from("repayment_records").insert(row).select("*").single();
    if (error) return json({ error: "repayments.add failed", detail: error }, 500);
    return json({ data }, 200);
  }

  if (action === "repayments.delete") {
    const id = payload?.id;
    if (!id) return json({ error: "Missing id" }, 400);
    const { error } = await supabase.from("repayment_records").delete().eq("openid", openid).eq("id", id);
    if (error) return json({ error: "repayments.delete failed", detail: error }, 500);
    return json({ ok: true }, 200);
  }

  return json({ error: "Unknown action" }, 400);
});
