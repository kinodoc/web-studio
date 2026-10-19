type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
type D1DatabaseLike = { prepare(query: string): D1StatementLike; batch(statements: D1StatementLike[]): Promise<unknown[]> };

interface Env {
  DB: D1DatabaseLike;
  ALLOWED_ORIGIN: string;
  ADMIN_PASSWORD: string;
  ADMIN_SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  ADMIN_EMAIL?: string;
  EMAIL_FROM?: string;
}

type Json = Record<string, unknown>;
const json = (data: Json, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

function cors(request: Request, env: Env): Headers {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === env.ALLOWED_ORIGIN;
  const headers = new Headers({ "Vary": "Origin" });
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
async function sha256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
async function makeSession(secret: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })));
  const signature = await sign(payload, secret);
  return payload + "." + signature;
}
async function validSession(request: Request, secret: string): Promise<boolean> {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  if (signature !== await sign(payload, secret)) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch { return false; }
}
async function body(request: Request): Promise<Json> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Json : {};
  } catch { return {}; }
}
function text(value: unknown, max = 5000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
async function sendEmail(env: Env, subject: string, message: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL || !env.EMAIL_FROM) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.ADMIN_EMAIL],
      subject,
      text: message,
    }),
  });
  if (!response.ok) throw new Error("Email notification failed");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request, env);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return origin === env.ALLOWED_ORIGIN
        ? new Response(null, { status: 204, headers })
        : json({ error: "Origin not allowed" }, 403);
    }
    if (origin && origin !== env.ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, headers);

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (route === "/api/health" && request.method === "GET") {
        return json({ ok: true }, 200, headers);
      }

      if (route === "/api/client/start" && request.method === "POST") {
        const data = await body(request);
        const token = text(data.token, 200);
        if (token.length < 32) return json({ error: "Invalid client token" }, 400, headers);
        const tokenHash = await sha256(token);
        const existing = await env.DB.prepare(
          "SELECT c.id FROM conversations c WHERE c.client_token_hash = ? OR EXISTS (SELECT 1 FROM client_devices d WHERE d.conversation_id = c.id AND d.token_hash = ?)"
        ).bind(tokenHash, tokenHash).first<{ id: string }>();
        if (existing) return json({ conversationId: existing.id }, 200, headers);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO conversations (id, client_token_hash) VALUES (?, ?)"
        ).bind(id, tokenHash).run();
        return json({ conversationId: id }, 201, headers);
      }

      // Create a short-lived, single-use code to move a conversation to another device.
      if (route === "/api/client/transfer/create" && request.method === "POST") {
        const data = await body(request);
        const token = text(data.token, 200);
        const conversationId = text(data.conversationId, 100);
        if (token.length < 32 || !conversationId) return json({ error: "Missing conversation credentials" }, 400, headers);
        const tokenHash = await sha256(token);
        const owner = await env.DB.prepare("SELECT c.id FROM conversations c WHERE c.id = ? AND (c.client_token_hash = ? OR EXISTS (SELECT 1 FROM client_devices d WHERE d.conversation_id = c.id AND d.token_hash = ?))").bind(conversationId, tokenHash, tokenHash).first();
        if (!owner) return json({ error: "Conversation not found" }, 404, headers);
        await env.DB.prepare("DELETE FROM transfer_codes WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') OR used_at IS NOT NULL").run();
        await env.DB.prepare("DELETE FROM transfer_codes WHERE conversation_id = ? AND used_at IS NULL").bind(conversationId).run();
        for (let attempt = 0; attempt < 12; attempt++) {
          const code = String(crypto.getRandomValues(new Uint16Array(1))[0] % 1000).padStart(3, "0");
          const codeHash = await sign("transfer:" + code, env.ADMIN_SESSION_SECRET);
          try {
            await env.DB.prepare("INSERT INTO transfer_codes (code_hash, conversation_id, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))").bind(codeHash, conversationId).run();
            return json({ code, expiresInSeconds: 300 }, 201, headers);
          } catch { /* Retry if another active conversation already has this code. */ }
        }
        return json({ error: "Could not create a transfer code. Please try again." }, 503, headers);
      }

      if (route === "/api/client/transfer/claim" && request.method === "POST") {
        const data = await body(request);
        const code = text(data.code, 3);
        const token = text(data.token, 200);
        if (!/^\d{3}$/.test(code) || token.length < 32) return json({ error: "Введите трёхзначный код." }, 400, headers);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = await sha256("transfer-ip:" + ip);
        await env.DB.prepare("INSERT INTO transfer_attempts (ip_hash, window_started_at, attempts) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1) ON CONFLICT(ip_hash) DO UPDATE SET attempts = CASE WHEN window_started_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') THEN 1 ELSE attempts + 1 END, window_started_at = CASE WHEN window_started_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE window_started_at END").bind(ipHash).run();
        const rate = await env.DB.prepare("SELECT attempts FROM transfer_attempts WHERE ip_hash = ?").bind(ipHash).first<{ attempts: number }>();
        if ((rate?.attempts || 0) > 8) return json({ error: "Слишком много попыток. Подождите пять минут и попробуйте снова." }, 429, headers);
        const codeHash = await sign("transfer:" + code, env.ADMIN_SESSION_SECRET);
        const tokenHash = await sha256(token);
        const claimed = await env.DB.prepare("UPDATE transfer_codes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code_hash = ? AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING conversation_id AS conversationId").bind(codeHash).first<{ conversationId: string }>();
        if (!claimed) return json({ error: "Код недействителен, истёк или уже использован. Создайте новый на первом устройстве." }, 400, headers);
        try {
          await env.DB.prepare("INSERT INTO client_devices (token_hash, conversation_id) VALUES (?, ?)").bind(tokenHash, claimed.conversationId).run();
        } catch {
          return json({ error: "Не удалось привязать устройство. Создайте новый код и попробуйте ещё раз." }, 409, headers);
        }
        return json({ ok: true, conversationId: claimed.conversationId }, 200, headers);
      }

      if (route === "/api/client/messages" && request.method === "GET") {
        const token = text((request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, ""), 200);
        const conversationId = text(url.searchParams.get("conversationId"), 100);
        if (token.length < 32 || !conversationId) return json({ error: "Missing conversation credentials" }, 400, headers);
        const tokenHash = await sha256(token);
        const owner = await env.DB.prepare(
          "SELECT c.id FROM conversations c WHERE c.id = ? AND (c.client_token_hash = ? OR EXISTS (SELECT 1 FROM client_devices d WHERE d.conversation_id = c.id AND d.token_hash = ?))"
        ).bind(conversationId, tokenHash, tokenHash).first();
        if (!owner) return json({ error: "Conversation not found" }, 404, headers);
        const result = await env.DB.prepare(
          "SELECT id, sender, body, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500"
        ).bind(conversationId).all();
        await env.DB.prepare(
          "UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND sender = 'admin' AND read_at IS NULL"
        ).bind(conversationId).run();
        return json({ messages: result.results }, 200, headers);
      }

      if (route === "/api/client/messages" && request.method === "POST") {
        const data = await body(request);
        const token = text(data.token, 200);
        const conversationId = text(data.conversationId, 100);
        const message = text(data.message, 5000);
        if (token.length < 32 || !conversationId || !message) return json({ error: "Message and conversation credentials are required" }, 400, headers);
        const tokenHash = await sha256(token);
        const owner = await env.DB.prepare(
          "SELECT c.id FROM conversations c WHERE c.id = ? AND (c.client_token_hash = ? OR EXISTS (SELECT 1 FROM client_devices d WHERE d.conversation_id = c.id AND d.token_hash = ?))"
        ).bind(conversationId, tokenHash, tokenHash).first();
        if (!owner) return json({ error: "Conversation not found" }, 404, headers);
        const recent = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND sender = 'client' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')"
        ).bind(conversationId).first<{ total: number }>();
        if ((recent?.total || 0) >= 12) return json({ error: "Please wait a moment before sending more messages." }, 429, headers);
        const id = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO messages (id, conversation_id, sender, body) VALUES (?, ?, 'client', ?)").bind(id, conversationId, message),
          env.DB.prepare("UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_message_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_message_preview = ?, unread_for_admin = 1 WHERE id = ?").bind(message.slice(0, 180), conversationId),
        ]);
        try {
          await sendEmail(env, "Новое сообщение в чате WEB STUDIO", "Новое сообщение в чате WEB STUDIO:\n\n" + message + "\n\nОткройте административную панель, чтобы ответить.");
        } catch {
          // Message is already saved. Email delivery failure must not undo or hide it.
        }
        return json({ ok: true, id }, 201, headers);
      }

      if (route === "/api/admin/login" && request.method === "POST") {
        const data = await body(request);
        const password = text(data.password, 1000);
        const loginIp = request.headers.get("CF-Connecting-IP") || "unknown";
        const loginIpHash = await sha256("admin-login-ip:" + loginIp);
        await env.DB.prepare("INSERT INTO admin_login_attempts (ip_hash, window_started_at, attempts) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1) ON CONFLICT(ip_hash) DO UPDATE SET attempts = CASE WHEN window_started_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') THEN 1 ELSE attempts + 1 END, window_started_at = CASE WHEN window_started_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE window_started_at END").bind(loginIpHash).run();
        const loginRate = await env.DB.prepare("SELECT attempts FROM admin_login_attempts WHERE ip_hash = ?").bind(loginIpHash).first<{ attempts: number }>();
        if ((loginRate?.attempts || 0) > 8) return json({ error: "Too many login attempts. Wait five minutes and try again." }, 429, headers);
        if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET || password !== env.ADMIN_PASSWORD) {
          return json({ error: "Invalid credentials" }, 401, headers);
        }
        return json({ token: await makeSession(env.ADMIN_SESSION_SECRET) }, 200, headers);
      }

      if (route.startsWith("/api/admin/")) {
        if (!env.ADMIN_SESSION_SECRET || !await validSession(request, env.ADMIN_SESSION_SECRET)) {
          return json({ error: "Unauthorized" }, 401, headers);
        }
        if (route === "/api/admin/conversations" && request.method === "GET") {
          const result = await env.DB.prepare(
            "SELECT id, created_at AS createdAt, last_message_at AS lastMessageAt, last_message_preview AS lastMessagePreview, unread_for_admin AS unread FROM conversations ORDER BY last_message_at DESC LIMIT 200"
          ).all();
          return json({ conversations: result.results }, 200, headers);
        }
        if (route === "/api/admin/messages" && request.method === "GET") {
          const conversationId = text(url.searchParams.get("conversationId"), 100);
          if (!conversationId) return json({ error: "Missing conversationId" }, 400, headers);
          const result = await env.DB.prepare(
            "SELECT id, sender, body, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500"
          ).bind(conversationId).all();
          await env.DB.prepare("UPDATE conversations SET unread_for_admin = 0 WHERE id = ?").bind(conversationId).run();
          await env.DB.prepare(
            "UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND sender = 'client' AND read_at IS NULL"
          ).bind(conversationId).run();
          return json({ messages: result.results }, 200, headers);
        }
        if (route === "/api/admin/messages" && request.method === "POST") {
          const data = await body(request);
          const conversationId = text(data.conversationId, 100);
          const message = text(data.message, 5000);
          if (!conversationId || !message) return json({ error: "Message and conversationId are required" }, 400, headers);
          const exists = await env.DB.prepare("SELECT id FROM conversations WHERE id = ?").bind(conversationId).first();
          if (!exists) return json({ error: "Conversation not found" }, 404, headers);
          const id = crypto.randomUUID();
          await env.DB.batch([
            env.DB.prepare("INSERT INTO messages (id, conversation_id, sender, body) VALUES (?, ?, 'admin', ?)").bind(id, conversationId, message),
            env.DB.prepare("UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_message_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_message_preview = ?, unread_for_admin = 0 WHERE id = ?").bind(message.slice(0, 180), conversationId),
          ]);
          return json({ ok: true, id }, 201, headers);
        }
      }
      return json({ error: "Not found" }, 404, headers);
    } catch {
      return json({ error: "Internal server error" }, 500, headers);
    }
  },
};
