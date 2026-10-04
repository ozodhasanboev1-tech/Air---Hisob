// Telegram Bot API calls and Mini App initData verification.

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

export function send(chatId: number, text: string, replyTo?: number) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the Telegram user when the signature is valid and not older than maxAgeSec.
export async function verifyInitData(initData: string, maxAgeSec = 7 * 24 * 3600): Promise<any | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}
