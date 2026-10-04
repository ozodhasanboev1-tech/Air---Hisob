// Backend for the Mini App. Every request carries Telegram's signed initData in the
// X-Telegram-Init-Data header; only users listed in OWNER_IDS may read or change the ledger.

import { deleteEntry, Entry, getMeta, listEntries, setMeta, upsertEntry } from "../_shared/db.ts";
import { verifyInitData } from "../_shared/telegram.ts";

const OWNER_IDS = (Deno.env.get("OWNER_IDS") || "6158024788").split(",").map((s) => Number(s.trim()));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-telegram-init-data",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function cleanEntry(e: any): Entry | null {
  if (!e || !isDate(e.date)) return null;
  const base = {
    id: typeof e.id === "string" && e.id ? e.id.slice(0, 80) : `app-${crypto.randomUUID()}`,
    date: e.date,
    note: String(e.note ?? "").slice(0, 500),
    createdAt: num(e.createdAt) || Date.now(),
    source: typeof e.source === "string" ? e.source.slice(0, 20) : "app",
  };
  if (e.kind === "shipment") {
    const items = (Array.isArray(e.items) ? e.items : [])
      .map((i: any) => ({ name: String(i?.name ?? "").trim().slice(0, 100), qty: num(i?.qty), price: num(i?.price) }))
      .filter((i: any) => i.name && i.qty > 0);
    if (!items.length) return null;
    const total = Math.round(items.reduce((s: number, i: any) => s + i.qty * i.price, 0) * 100) / 100;
    return { ...base, kind: "shipment", items, total, sender: e.sender ?? null };
  }
  if (e.kind === "payment") {
    const amount = num(e.amount);
    if (!(amount > 0)) return null;
    return {
      ...base,
      kind: "payment",
      method: e.method === "perechisleniya" ? "perechisleniya" : "naqd",
      amount,
      sumUzs: e.sumUzs ? num(e.sumUzs) : null,
      rate: e.rate ? num(e.rate) : null,
      sender: e.sender ?? null,
    };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const user = await verifyInitData(req.headers.get("X-Telegram-Init-Data") || "");
  if (!user) return json({ error: "auth", message: "Ilovani Telegram ichidan oching." }, 401);
  if (!OWNER_IDS.includes(user.id)) return json({ error: "forbidden", message: "Sizga ruxsat berilmagan." }, 403);

  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "load": {
        const [entries, prices, telegram] = await Promise.all([listEntries(), getMeta("prices"), getMeta("telegram")]);
        return json({ entries, prices: prices.items || {}, telegram: { lastRun: telegram.lastRun, lastError: telegram.lastError, lastShipmentAt: telegram.lastShipmentAt }, user: { id: user.id, first_name: user.first_name } });
      }
      case "save": {
        const e = cleanEntry(body.entry);
        if (!e) return json({ error: "invalid", message: "Yozuv noto'g'ri to'ldirilgan." }, 400);
        const [row] = await upsertEntry(e);
        return json({ ok: true, id: row.id });
      }
      case "delete": {
        if (typeof body.id !== "string" || !body.id) return json({ error: "invalid" }, 400);
        await deleteEntry(body.id);
        return json({ ok: true });
      }
      case "prices": {
        const items: Record<string, number> = {};
        for (const [k, v] of Object.entries(body.items || {})) {
          const name = String(k).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
          if (name && num(v) > 0) items[name] = num(v);
        }
        await setMeta("prices", { currency: "USD", items, updatedAt: new Date().toISOString() });
        return json({ ok: true, items });
      }
      default:
        return json({ error: "action" }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "server", message: "Serverda xatolik, qayta urinib ko'ring." }, 500);
  }
});
