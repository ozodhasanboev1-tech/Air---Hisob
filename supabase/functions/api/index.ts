// Backend for the Mini App. Every request carries Telegram's signed initData in the
// X-Telegram-Init-Data header; only users listed in OWNER_IDS may read or change the ledger.

import {
  deleteEntry, Entry, Firm, getMeta, listEntries, listFirms, photoUrl, rest, rowToEntry, shipmentTotals, updateFirm, upsertEntry,
} from "../_shared/db.ts";
import { verifyInitData } from "../_shared/telegram.ts";
import { hasOcrKey, readListPhoto } from "../_shared/ocr.ts";
import { norm } from "../_shared/parse.ts";

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

function cleanEntry(e: any, firms: Firm[]): Entry | null {
  const firm = e?.firm || "air";
  const f = firms.find((x) => x.id === firm);
  if (!e || !isDate(e.date) || !f) return null;
  const base = {
    firm,
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
    const pct = e.discountPct == null ? Number(f.discount_pct) || 0 : Math.min(100, Math.max(0, num(e.discountPct)));
    const { gross, total } = shipmentTotals(items, pct);
    return { ...base, kind: "shipment", items, total, gross, discountPct: pct, sender: e.sender ?? null };
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
        const [entries, firms, telegram] = await Promise.all([listEntries(), listFirms(), getMeta("telegram")]);
        return json({ entries, firms: firms.map((f) => ({ id: f.id, name: f.name, prices: f.prices || {}, discountPct: Number(f.discount_pct) || 0, linked: !!f.chat_id })), ocr: hasOcrKey(), telegram: { lastRun: telegram.lastRun, lastError: telegram.lastError, lastShipmentAt: telegram.lastShipmentAt }, user: { id: user.id, first_name: user.first_name } });
      }
      case "save": {
        const e = cleanEntry(body.entry, await listFirms());
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
        if (typeof body.firm !== "string" || !(await listFirms()).some((f) => f.id === body.firm)) {
          return json({ error: "invalid", message: "Firma topilmadi." }, 400);
        }
        await updateFirm(body.firm, { prices: items });
        // Fill in shipments that were recorded before the product had a price.
        const map: Record<string, number> = {};
        for (const [k, v] of Object.entries(items)) map[norm(k)] = v;
        let filled = 0;
        for (const e of await listEntries(body.firm)) {
          if (e.kind !== "shipment" || !(e.items || []).some((i) => !i.price && map[norm(i.name)])) continue;
          const its = e.items!.map((i) => (i.price ? i : { ...i, price: map[norm(i.name)] || 0 }));
          await upsertEntry({ ...e, items: its, ...shipmentTotals(its, e.discountPct || 0) });
          filled++;
        }
        return json({ ok: true, items, filled });
      }
      case "firm": {
        const f = (await listFirms()).find((x) => x.id === body.firm);
        if (!f) return json({ error: "invalid", message: "Firma topilmadi." }, 400);
        const pct = num(body.discountPct);
        if (pct < 0 || pct >= 100) return json({ error: "invalid", message: "Chegirma 0 dan 99 gacha bo'lsin." }, 400);
        await updateFirm(f.id, { discount_pct: pct });
        return json({ ok: true, discountPct: pct });
      }
      case "original": {
        // The Telegram post a shipment came from: its text and/or a short-lived link to the photo.
        if (typeof body.id !== "string" || !body.id) return json({ error: "invalid" }, 400);
        const [row] = await rest(`entries?id=eq.${encodeURIComponent(body.id)}&select=*`);
        const o = row && rowToEntry(row).original;
        if (!o) return json({ error: "none", message: "Bu yukning asl nusxasi saqlanmagan." }, 404);
        return json({ ok: true, text: o.text || "", from: o.from || "", at: o.at || null, editedAt: o.editedAt || null, deletedAt: o.deletedAt || null, history: o.history || [], photo: o.photo ? await photoUrl(o.photo) : null });
      }
      case "ocr": {
        if (!hasOcrKey()) return json({ error: "ocr", message: "Rasm o'qish uchun GEMINI_API_KEY (bepul) qo'yilmagan." }, 400);
        const f = (await listFirms()).find((x) => x.id === body.firm);
        if (!f || typeof body.image !== "string" || body.image.length > 7_000_000) {
          return json({ error: "invalid", message: "Rasm juda katta yoki firma topilmadi." }, 400);
        }
        const media = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType) ? body.mediaType : "image/jpeg";
        const lists = await readListPhoto(body.image, media, Object.keys(f.prices || {}));
        return json({ ok: true, lists });
      }
      default:
        return json({ error: "action" }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "server", message: "Serverda xatolik, qayta urinib ko'ring." }, 500);
  }
});
