// Backend for the Mini App. Every request carries Telegram's signed initData in the
// X-Telegram-Init-Data header; only users listed in OWNER_IDS may read or change the ledger.
// Viewers (meta key "viewers": {"<telegram id>": {name, firms: ["sa", …] or "*"}}) may only look,
// and only at the firms listed for them.

import {
  deleteEntry, Entry, Firm, getMeta, listEntries, listFirms, photoUrl, rest, rowToEntry, shipmentTotals, updateFirm, upsertEntry,
} from "../_shared/db.ts";
import { verifyInitData } from "../_shared/telegram.ts";
import { hasOcrKey, readListPhoto } from "../_shared/ocr.ts";
import { norm } from "../_shared/parse.ts";

const VIEW_ACTIONS = ["load", "original", "stockPhoto"];
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
  const owner = OWNER_IDS.includes(user.id);
  const viewer = owner ? null : ((await getMeta("viewers")) || {})[String(user.id)];
  if (!owner && !viewer) return json({ error: "forbidden", message: `Sizga ruxsat berilmagan. Telegram ID: ${user.id}` }, 403);
  const sees = (firmId: string) => owner || viewer.firms === "*" || (viewer.firms || []).includes(firmId);

  const body = await req.json().catch(() => ({}));
  if (!owner && !VIEW_ACTIONS.includes(body.action)) return json({ error: "forbidden", message: "Sizda faqat ko'rish huquqi bor." }, 403);
  try {
    switch (body.action) {
      case "load": {
        const [allEntries, allFirms, telegram, allStock] = await Promise.all([
          listEntries(), listFirms(), getMeta("telegram"),
          rest("stock_docs?select=id,firm,kind,date,party,items,sender,original,created_at&order=date.asc,created_at.asc"),
        ]);
        const firms = allFirms.filter((f) => sees(f.id));
        const entries = allEntries.filter((e) => sees(e.firm || "air"));
        const stock = allStock.filter((d: any) => sees(d.firm));
        // Warehouse firms (SA): stock in boxes, shown in their own tab of the app.
        const sklad = firms.filter((f) => f.kind === "sklad").map((f) => ({
          id: f.id, name: f.name, skus: f.skus || {},
          docs: stock.filter((d: any) => d.firm === f.id).map((d: any) => ({ ...d, createdAt: Number(d.created_at), created_at: undefined })),
        }));
        return json({ sklad, entries, firms: firms.filter((f) => f.kind !== "sklad").map((f) => ({ id: f.id, name: f.name, prices: f.prices || {}, discountPct: Number(f.discount_pct) || 0, linked: !!f.chat_id })), ocr: hasOcrKey(), telegram: { lastRun: telegram.lastRun, lastError: telegram.lastError, lastShipmentAt: telegram.lastShipmentAt }, user: { id: user.id, first_name: user.first_name, role: owner ? "owner" : "viewer" } });
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
          if (name) items[name] = Math.max(0, num(v)); // 0 = product known, price not set yet
        }
        if (typeof body.firm !== "string" || !(await listFirms()).some((f) => f.id === body.firm)) {
          return json({ error: "invalid", message: "Firma topilmadi." }, 400);
        }
        await updateFirm(body.firm, { prices: items });
        // Renamed products take the new name in old shipments too; then fill in shipments that were
        // recorded before the product had a price.
        const renames: Record<string, string> = {};
        for (const [from, to] of Object.entries(body.renames || {})) {
          const t = String(to).replace(/\s+/g, " ").trim().slice(0, 100);
          if (t && norm(from) !== norm(t)) renames[norm(from)] = t;
        }
        const map: Record<string, number> = {};
        for (const [k, v] of Object.entries(items)) map[norm(k)] = v;
        let filled = 0;
        for (const e of await listEntries(body.firm)) {
          if (e.kind !== "shipment") continue;
          const renamed = (e.items || []).map((i) => (renames[norm(i.name)] ? { ...i, name: renames[norm(i.name)] } : i));
          const changed = renamed.some((i, n) => i !== e.items![n]);
          if (!changed && !renamed.some((i) => !i.price && map[norm(i.name)])) continue;
          const its = renamed.map((i) => (i.price ? i : { ...i, price: map[norm(i.name)] || 0 }));
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
        const o = row && sees(row.firm || "air") && rowToEntry(row).original;
        if (!o) return json({ error: "none", message: "Bu yukning asl nusxasi saqlanmagan." }, 404);
        return json({ ok: true, text: o.text || "", from: o.from || "", at: o.at || null, editedAt: o.editedAt || null, deletedAt: o.deletedAt || null, history: o.history || [], photo: o.photo ? await photoUrl(o.photo) : null });
      }
      case "stockPhoto": {
        if (typeof body.id !== "string" || !body.id) return json({ error: "invalid" }, 400);
        const [row] = await rest(`stock_docs?id=eq.${encodeURIComponent(body.id)}&select=firm,original`);
        const path = row && sees(row.firm) && row.original?.photo;
        if (!path) return json({ error: "none", message: "Rasm saqlanmagan." }, 404);
        return json({ ok: true, photo: await photoUrl(path) });
      }
      case "ocr": {
        if (!hasOcrKey()) return json({ error: "ocr", message: "Rasm o'qish uchun ANTHROPIC_API_KEY qo'yilmagan." }, 400);
        const f = (await listFirms()).find((x) => x.id === body.firm);
        if (!f || typeof body.image !== "string" || body.image.length > 7_000_000) {
          return json({ error: "invalid", message: "Rasm juda katta yoki firma topilmadi." }, 400);
        }
        const media = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType) ? body.mediaType : "image/jpeg";
        try {
          const lists = await readListPhoto(body.image, media, Object.keys(f.prices || {}));
          return json({ ok: true, lists });
        } catch (err) {
          console.error(err);
          return json({ error: "ocr", message: `Rasmni o'qib bo'lmadi: ${String(err).slice(0, 200)}` }, 502);
        }
      }
      default:
        return json({ error: "action" }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "server", message: "Serverda xatolik, qayta urinib ko'ring." }, 500);
  }
});
