// Telegram webhook for @Air_Hisobi_bot.
// - Бобур's posts in the group become shipments.
// - The owner (OWNER_IDS) records payments, cancels them (otkaz) and asks for the balance (qoldiq).
// Telegram calls this URL with the X-Telegram-Bot-Api-Secret-Token header set by setWebhook.

import {
  deleteEntry, Entry, fmt, getMeta, listEntries, rest, rowToEntry, setMeta, summary,
  tashkentDate, tashkentNow, upsertEntry,
} from "../_shared/db.ts";
import { send, tg } from "../_shared/telegram.ts";
import { BALANCE_RE, CANCEL_RE, norm, parseCancel, parsePayment, parseShipment } from "../_shared/parse.ts";

const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") || "";
const OWNER_IDS = (Deno.env.get("OWNER_IDS") || "6158024788").split(",").map((s) => Number(s.trim()));
const APP_URL = Deno.env.get("APP_URL") || "";

const METHOD_LABEL = { naqd: "Naqd", perechisleniya: "Perechisleniya" } as const;
const docId = (chatId: number, msgId: number) => `tg-${String(chatId).replace("-", "")}-${msgId}`;
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

const HELP = [
  "Air hisob-kitobi boti.",
  "",
  "To'lov: «naqd 500$», «perech 785 $ Elyor uchun», «perech 5 000 000 so'm kurs 12650»",
  "Bekor qilish: «otkaz perech 04.10» yoki «otkaz naqd 04.10 500$» (yoki ✅ xabariga javoban «otkaz»)",
  "Qoldiq: «qoldiq»",
  APP_URL ? "\nTo'liq hisobot: pastdagi «Hisob» tugmasi." : "",
].join("\n");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json().catch(() => null);
  try {
    if (update) await handle(update);
  } catch (err) {
    console.error(err);
    const t = await getMeta("telegram").catch(() => ({}));
    await setMeta("telegram", { ...t, lastRun: new Date().toISOString(), lastError: String(err).slice(0, 200) })
      .catch(() => {});
  }
  // Always 200 so Telegram does not resend the same update forever.
  return new Response("ok");
});

async function handle(update: any) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const text: string = (msg.text || msg.caption || "").trim();
  const chat = msg.chat;
  const from = msg.from || {};
  const isPrivate = chat.type === "private";
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  // A basic group upgraded to a supergroup gets a new id.
  if (msg.migrate_to_chat_id) {
    const t = await getMeta("telegram");
    if (t.chatId === chat.id) await setMeta("telegram", { ...t, chatId: msg.migrate_to_chat_id });
    return;
  }
  if (!text) return;

  if (OWNER_IDS.includes(from.id)) {
    if (isPrivate && /^\/(start|help|yordam)/i.test(text)) return void await send(chat.id, HELP);
    if (isPrivate && BALANCE_RE.test(text)) return void await balance(chat.id);
    if (CANCEL_RE.test(text)) return void await cancel(msg, text, isPrivate);
    if (await payment(msg, text, isPrivate)) return;
    if (isPrivate) return void await send(chat.id, "Tushunmadim.\n\n" + HELP);
  }

  if (isGroup) await shipment(msg, text);
}

// ---------- payments ----------
async function payment(msg: any, text: string, isPrivate: boolean): Promise<boolean> {
  const p = parsePayment(text);
  if (!p) return false;
  if (p.needRate) {
    if (isPrivate) {
      await send(msg.chat.id, `So'mdagi to'lov uchun kursni ham yozing, masalan:\n«${text} kurs 12650»`, msg.message_id);
    }
    return true;
  }
  const date = tashkentDate(msg.date);
  const entry: Entry = {
    id: docId(msg.chat.id, msg.message_id),
    kind: "payment",
    method: p.method,
    date,
    amount: p.amount!,
    sumUzs: p.sumUzs ?? null,
    rate: p.rate ?? null,
    note: p.note || "Telegram bot orqali",
    createdAt: msg.date * 1000,
    source: "telegram",
    sender: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
  };
  await upsertEntry(entry);
  const label = METHOD_LABEL[p.method];
  const uzs = p.sumUzs ? ` (${fmt(p.sumUzs)} so'm, kurs ${fmt(p.rate!)})` : "";
  if (isPrivate) await send(msg.chat.id, `✅ ${label} ${fmt(p.amount!)} $${uzs} yozildi (${ddmm(date)})`, msg.message_id);
  else await react(msg);
  return true;
}

async function react(msg: any) {
  await tg("setMessageReaction", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    reaction: [{ type: "emoji", emoji: "👍" }],
  }).catch(() => {});
}

// ---------- otkaz ----------
async function cancel(msg: any, text: string, isPrivate: boolean) {
  const chatId = msg.chat.id;
  const reply = (t: string) => send(chatId, t, msg.message_id);
  const tashkentYear = Number(tashkentDate(msg.date).slice(0, 4));
  let { date, method, amount } = parseCancel(text, tashkentYear);
  const replied = msg.reply_to_message;

  let found: Entry[] = [];
  if (replied) {
    // Reply to the original payment message …
    const direct = await rest(`entries?id=eq.${docId(chatId, replied.message_id)}&kind=eq.payment&select=*`);
    found = direct.map(rowToEntry);
    // … or to the bot's "✅ Perechisleniya 785 $ yozildi (04.10)" confirmation.
    if (!found.length && replied.text) {
      const p = parsePayment(replied.text.replace(/^✅\s*/, "").replace(/\(.*$/, ""));
      const d = replied.text.match(/\((\d{2})\.(\d{2})\)\s*$/);
      if (p) { method ??= p.method; amount ??= p.amount; }
      if (d && !date) date = `${tashkentYear}-${d[2]}-${d[1]}`;
    }
  }
  if (!found.length) {
    if (!date) {
      if (isPrivate) await reply("Qaysi to'lovni bekor qilay? Sana bilan yozing: «otkaz perech 04.10» yoki «otkaz naqd 04.10 500$».");
      return;
    }
    let q = `entries?kind=eq.payment&date=eq.${date}&select=*&order=created_at.asc`;
    if (method) q += `&method=eq.${method}`;
    found = (await rest(q)).map(rowToEntry);
    if (amount) found = found.filter((e) => Math.abs((e.amount || 0) - amount!) < 0.01 || Math.abs((e.sumUzs || -1) - amount!) < 1);
  }

  if (found.length === 0) return void await reply("Bu sanada bunday to'lov topilmadi.");
  if (found.length > 1) {
    const list = found.map((e, i) => `${i + 1}) ${METHOD_LABEL[e.method!]} ${fmt(e.amount!)} $ ${e.note || ""}`.trim()).join("\n");
    return void await reply(`Bir nechta to'lov topildi:\n${list}\n\nSummasi bilan qayta yozing, masalan «otkaz naqd ${ddmm(found[0].date)} ${fmt(found[0].amount!)}$».`);
  }
  const e = found[0];
  await deleteEntry(e.id);
  await reply(`❌ ${METHOD_LABEL[e.method!]} ${fmt(e.amount!)} $ (${ddmm(e.date)}) bekor qilindi`);
}

// ---------- qoldiq ----------
async function balance(chatId: number) {
  const s = summary(await listEntries());
  const head = s.balance >= 0
    ? `📊 Qoldiq: ${fmt(s.balance)} $ (Air'ga qarzimiz)`
    : `📊 Ortiqcha to'langan: ${fmt(-s.balance)} $`;
  await send(chatId, `${head}\nYuklar: ${fmt(s.ship)} $\nNaqd: ${fmt(s.naqd)} $\nPerechisleniya: ${fmt(s.perech)} $\n${tashkentNow()}`);
}

// ---------- Бобур's shipments ----------
async function shipment(msg: any, text: string) {
  const t = await getMeta("telegram");
  if (t.chatId && t.chatId !== msg.chat.id) return; // only the "Айр хисоб китоб" group
  const boburIds: number[] = t.boburIds || [];
  const from = msg.from || {};
  const name = [from.first_name, from.last_name, from.username].filter(Boolean).join(" ");
  const isBobur = boburIds.length ? boburIds.includes(from.id) : /бобур|bobur/i.test(name);
  if (!isBobur) return;

  const parsed = parseShipment(text);
  const next = { ...t, chatId: t.chatId || msg.chat.id, boburIds: boburIds.length ? boburIds : [from.id], lastRun: new Date().toISOString(), lastError: "" };
  if (!parsed.items.length) return void await setMeta("telegram", next);

  const prices = await priceMap();
  const items = parsed.items.map((it) => ({ ...it, price: prices[norm(it.name)] || 0 }));
  const total = Math.round(items.reduce((s, it) => s + it.qty * it.price, 0) * 100) / 100;
  await upsertEntry({
    id: docId(msg.chat.id, msg.message_id),
    kind: "shipment",
    date: tashkentDate(msg.date),
    note: parsed.note,
    items,
    total,
    createdAt: msg.date * 1000,
    source: "telegram",
    sender: "Бобур",
  });
  await setMeta("telegram", { ...next, lastAdded: (t.lastAdded || 0) + 1, lastShipmentAt: new Date().toISOString() });
}

// meta/prices first, then the latest positive price seen in earlier shipments.
async function priceMap(): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const rows = await rest("entries?kind=eq.shipment&select=items&order=date.asc,created_at.asc");
  for (const r of rows) for (const it of r.items || []) if (it.price > 0) map[norm(it.name)] = it.price;
  const p = (await getMeta("prices")).items || {};
  for (const k of Object.keys(p)) if (p[k] > 0) map[norm(k)] = p[k];
  return map;
}
