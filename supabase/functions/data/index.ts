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

  let openid = "";
  try {
    openid = await requireOpenId(req);
  } catch (e) {
    return json({ error: "Unauthorized", detail: String(e) }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 统一补 openid
  const payload = body.payload ?? {};

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
      remaining_periods: r.remaining_periods ?? null,
    };
    const { data, error } = await supabase.from("repayment_records").insert(row).select("*").single();
    if (error) return json({ error: "repayments.add failed", detail: error }, 500);
    return json({ data }, 200);
  }

  return json({ error: "Unknown action" }, 400);
});

