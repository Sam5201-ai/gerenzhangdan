// Supabase Edge Function: wx-login
// 用途：微信小程序 wx.login(code) -> openid，并签发应用侧 token（不依赖 Supabase Auth）
//
// 需要在 Supabase 项目中配置 Secrets：
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - WECHAT_APPID
// - WECHAT_SECRET
// - APP_JWT_SECRET   (用于签发/校验应用 token)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { SignJWT } from "https://esm.sh/jose@5.9.6";

type WxSessionResp = {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const WECHAT_APPID = Deno.env.get("WECHAT_APPID")!;
  const WECHAT_SECRET = Deno.env.get("WECHAT_SECRET")!;
  const APP_JWT_SECRET = Deno.env.get("APP_JWT_SECRET")!;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !WECHAT_APPID || !WECHAT_SECRET || !APP_JWT_SECRET) {
    return json({ error: "Missing server env" }, 500);
  }

  let body: { code?: string; nickname?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const code = (body.code || "").trim();
  if (!code) return json({ error: "Missing wx.login code" }, 400);

  const url =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(WECHAT_APPID)}` +
    `&secret=${encodeURIComponent(WECHAT_SECRET)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  const wxRes = await fetch(url);
  const wxJson = (await wxRes.json()) as WxSessionResp;
  if (!wxJson.openid) {
    return json({ error: "WeChat jscode2session failed", detail: wxJson }, 401);
  }

  const openid = wxJson.openid;
  const nickname = (body.nickname || "").trim() || null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // upsert 用户 + 更新 last_login_at
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await supabase.from("app_users").upsert(
    {
      openid,
      nickname,
      last_login_at: nowIso,
    },
    { onConflict: "openid" },
  );

  if (upsertErr) return json({ error: "Upsert user failed", detail: upsertErr }, 500);

  // 签发应用 token（默认 7 天有效）
  const token = await new SignJWT({ openid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(APP_JWT_SECRET));

  return json({ openid, token }, 200);
});

