// Telegram webhook for @Air_Hisobi_bot.
// - Each firm (Air, Timson, ...) has its own Telegram group. Shipment lists posted there by the
//   firm's poster (Бобур for Air) become shipments of that firm.
// - The owner (OWNER_IDS) records payments (the bot asks which firm with buttons), cancels them
//   (otkaz), asks for the balance (qoldiq), links a group to a firm (/firma Nomi) and marks who
//   posts shipments (/yuk as a reply to that person's message).
// Telegram calls this URL with the X-Telegram-Bot-Api-Secret-Token header set by setWebhook.

import {
  createFirm, deleteEntry, Entry, Firm, firmByChat, fmt, getMeta, listEntries, listFirms, rest, rowToEntry,
  setMeta, shipmentTotals, slugify, summary, tashkentDate, tashkentNow, updateFirm, upsertEntry,
} from "../_shared/db.ts";
import { downloadFile, send, tg } from "../_shared/telegram.ts";
import { bytesToBase64, hasOcrKey, readListPhoto } from "../_shared/ocr.ts";
import { BALANCE_RE, CANCEL_RE, norm, parseCancel, parsePayment, parseShipments, Payment } from "../_shared/parse.ts";

const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") || "";
const OWNER_IDS = (Deno.env.get("OWNER_IDS") || "6158024788").split(",").map((s) => Number(s.trim()));
const APP_URL = Deno.env.get("APP_URL") || "";

const METHOD_LABEL = { naqd: "Naqd", perechisleniya: "Perechisleniya" } as const;
const docId = (chatId: number, msgId: number) => `tg-${String(chatId).replace("-", "")}-${msgId}`;
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const FIRM_CMD_RE = /^\/?firma(?:@\w+)?\s+(.+)$/i;
const POSTER_CMD_RE = /^\/yuk(?:@\w+)?\s*$/i;

const HELP = [
  "Air hisob-kitobi boti.",
  "",
  "To'lov: «naqd 500$», «perech 785 $ Elyor uchun», «perech 5 000 000 so'm kurs 12650». Bot qaysi firmaga ekanini so'raydi. Firma nomini oldinga yozsangiz so'ramaydi: «timson naqd 500$».",
  "Bekor qilish: «otkaz perech 04.10» yoki «otkaz naqd 04.10 500$» (yoki ✅ xabariga javoban «otkaz»)",
  "Qoldiq: «qoldiq» (hamma firmalar) yoki «qoldiq timson»",
  "",
  "Yangi firma: botni o'sha firmaning guruhiga qo'shing va guruhda «/firma Nomi» deb yozing.",
  "Yuk tashlovchi: o'sha odamning ro'yxatiga javoban «/yuk» deb yozing.",
  APP_URL ? "\nTo'liq hisobot: pastdagi «Hisob» tugmasi." : "",
].join("\n");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json().catch(() => null);
  try {
    if (update?.callback_query) await onButton(update.callback_query);
    else if (update?.my_chat_member) await onAddedToGroup(update.my_chat_member);
    else if (update) await handle(update);
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
    const f = await firmByChat(chat.id);
    if (f) await updateFirm(f.id, { chat_id: msg.migrate_to_chat_id });
    return;
  }
  const firm = isGroup ? await firmByChat(chat.id) : null;
  if (isGroup && firm && msg.photo && !update.edited_message) return void await photoShipment(msg, firm);
  if (!text) return;

  if (OWNER_IDS.includes(from.id)) {
    if (isPrivate && /^\/(start|help|yordam)/i.test(text)) return void await send(chat.id, HELP);
    if (isGroup && FIRM_CMD_RE.test(text)) return void await linkGroup(msg, text.match(FIRM_CMD_RE)![1].trim());
    if (isGroup && POSTER_CMD_RE.test(text)) return void await markPoster(msg, firm);
    if (isPrivate && BALANCE_RE.test(text)) return void await balance(chat.id, text);
    if (CANCEL_RE.test(text)) return void await cancel(msg, text, isPrivate);
    if (await payment(msg, text, isPrivate, firm, !!update.edited_message)) return;
    if (isPrivate) return void await send(chat.id, "Tushunmadim.\n\n" + HELP);
  }

  if (isGroup && firm) await shipment(msg, text, firm);
}

// ---------- groups and firms ----------
async function onAddedToGroup(m: any) {
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const was = m.old_chat_member?.status, now = m.new_chat_member?.status;
  const joined = (was === "left" || was === "kicked") && (now === "member" || now === "administrator");
  if (!isGroup || !joined) return;
  const firm = await firmByChat(m.chat.id);
  await send(m.chat.id, firm
    ? `Salom! Bu guruh «${firm.name}» hisobiga ulangan.`
    : "Salom! Bu guruh qaysi firmaniki? Ozodbek, guruhda «/firma Nomi» deb yozing (masalan «/firma Timson»).");
}

async function linkGroup(msg: any, name: string) {
  const chatId = msg.chat.id;
  const firms = await listFirms();
  let firm = firms.find((f) => norm(f.name) === norm(name) || f.id === slugify(name));
  const old = firms.find((f) => f.chat_id === chatId);
  if (old && old.id !== firm?.id) await updateFirm(old.id, { chat_id: null });
  if (firm) firm = await updateFirm(firm.id, { chat_id: chatId });
  else {
    let id = slugify(name);
    if (firms.some((f) => f.id === id)) id = `${id}-${Date.now().toString(36)}`;
    firm = await createFirm({ id, name, chat_id: chatId, sort: firms.length });
  }
  await send(chatId, `✅ Bu guruh endi «${firm.name}» hisobi.\nYuk ro'yxatini kim tashlasa, uning xabariga javoban «/yuk» deb yozing.`, msg.message_id);
}

async function markPoster(msg: any, firm: Firm | null) {
  const chatId = msg.chat.id;
  if (!firm) return void await send(chatId, "Avval guruhni firmaga bog'lang: «/firma Nomi».", msg.message_id);
  const r = msg.reply_to_message;
  if (!r?.from || r.from.is_bot) return void await send(chatId, "«/yuk» ni yuk tashlovchining xabariga javob qilib yozing.", msg.message_id);
  const ids = [...new Set([...(firm.poster_ids || []), r.from.id])];
  firm = await updateFirm(firm.id, { poster_ids: ids });
  const who = [r.from.first_name, r.from.last_name].filter(Boolean).join(" ");
  if (r.photo) {
    await send(chatId, `✅ ${who} endi «${firm.name}» yuklarini yozadi. Rasm o'qilyapti…`, msg.message_id);
    return void await photoShipment(r, firm);
  }
  const added = await shipment(r, (r.text || r.caption || "").trim(), firm);
  await send(chatId, `✅ ${who} endi «${firm.name}» yuklarini yozadi.${added ? " Bu ro'yxat ham yozildi." : ""}`, msg.message_id);
}

// The firm named at the start of a payment text ("timson naqd 500$"), if any.
function firmPrefix(text: string, firms: Firm[]): { firm?: Firm; rest: string } {
  const t = norm(text);
  for (const f of [...firms].sort((a, b) => b.name.length - a.name.length)) {
    for (const key of [norm(f.name), f.id]) {
      if (t.startsWith(key + " ")) return { firm: f, rest: text.trim().slice(key.length).trim() };
    }
  }
  return { rest: text };
}

// ---------- payments ----------
async function payment(msg: any, text: string, isPrivate: boolean, groupFirm: Firm | null, edited: boolean): Promise<boolean> {
  const firms = await listFirms();
  const pre = firmPrefix(text, firms);
  const p = parsePayment(pre.rest);
  if (!p) return false;
  if (p.needRate) {
    if (isPrivate) {
      await send(msg.chat.id, `So'mdagi to'lov uchun kursni ham yozing, masalan:\n«${text} kurs 12650»`, msg.message_id);
    }
    return true;
  }
  const id = docId(msg.chat.id, msg.message_id);
  let firm = pre.firm || groupFirm || (firms.length === 1 ? firms[0] : undefined);
  if (!firm && edited) {
    const prev = await rest(`entries?id=eq.${id}&select=firm`);
    firm = firms.find((f) => f.id === prev[0]?.firm);
  }
  if (!firm) {
    // Ask which firm; the answer comes back in onButton with this message as reply_to_message.
    const rows = [];
    for (let i = 0; i < firms.length; i += 2) {
      rows.push(firms.slice(i, i + 2).map((f) => ({ text: f.name, callback_data: `pay:${f.id}` })));
    }
    rows.push([{ text: "✖️ Bekor", callback_data: "pay:-" }]);
    await send(msg.chat.id, `Qaysi firmaga? ${METHOD_LABEL[p.method]} ${fmt(p.amount!)} $`, msg.message_id, {
      reply_markup: { inline_keyboard: rows },
    });
    return true;
  }
  const date = await savePayment(msg, p, firm, id);
  const text2 = confirmText(p, firm, date);
  if (isPrivate) await send(msg.chat.id, text2, msg.message_id);
  else await react(msg);
  return true;
}

async function savePayment(msg: any, p: Payment, firm: Firm, id: string): Promise<string> {
  const date = tashkentDate(msg.date);
  await upsertEntry({
    id,
    firm: firm.id,
    kind: "payment",
    method: p.method,
    date,
    amount: p.amount!,
    sumUzs: p.sumUzs ?? null,
    rate: p.rate ?? null,
    note: p.note || "Telegram bot orqali",
    createdAt: msg.date * 1000,
    source: "telegram",
    sender: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "),
  });
  return date;
}

function confirmText(p: Payment, firm: Firm, date: string) {
  const uzs = p.sumUzs ? ` (${fmt(p.sumUzs)} so'm, kurs ${fmt(p.rate!)})` : "";
  return `✅ ${METHOD_LABEL[p.method]} ${fmt(p.amount!)} $${uzs} yozildi (${ddmm(date)}) · ${firm.name}`;
}

async function onButton(q: any) {
  const answer = (text?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
  const data: string = q.data || "";
  const prompt = q.message;
  if (!data.startsWith("pay:") || !prompt) return void await answer();
  if (!OWNER_IDS.includes(q.from.id)) return void await answer("Ruxsat yo'q");
  const edit = (text: string) => tg("editMessageText", { chat_id: prompt.chat.id, message_id: prompt.message_id, text });
  if (data === "pay:-") {
    await edit("✖️ To'lov yozilmadi");
    return void await answer();
  }
  const orig = prompt.reply_to_message;
  const firms = await listFirms();
  const firm = firms.find((f) => f.id === data.slice(4));
  const p = orig && parsePayment(firmPrefix((orig.text || "").trim(), firms).rest);
  if (!firm || !p || p.needRate) {
    await edit("Bu to'lovni topa olmadim, qaytadan yozing.");
    return void await answer();
  }
  const date = await savePayment(orig, p, firm, docId(orig.chat.id, orig.message_id));
  await edit(confirmText(p, firm, date));
  await answer("Yozildi");
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
  const firms = await listFirms();
  const firmName = (id?: string) => firms.find((f) => f.id === id)?.name || "";
  let { date, method, amount } = parseCancel(text, tashkentYear);
  let firmId = firms.find((f) => new RegExp(`(^|\\s)(${f.id}|${norm(f.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(\\s|$)`, "i").test(norm(text)))?.id;
  const replied = msg.reply_to_message;

  let found: Entry[] = [];
  if (replied) {
    // Reply to the original payment message …
    const direct = await rest(`entries?id=eq.${docId(chatId, replied.message_id)}&kind=eq.payment&select=*`);
    found = direct.map(rowToEntry);
    // … or to the bot's "✅ Perechisleniya 785 $ yozildi (04.10) · Air" confirmation.
    if (!found.length && replied.text) {
      const p = parsePayment(replied.text.replace(/^✅\s*/, "").replace(/\(.*$/, ""));
      const d = replied.text.match(/\((\d{2})\.(\d{2})\)/);
      const fn = replied.text.match(/·\s*(.+)$/);
      if (p) { method ??= p.method; amount ??= p.amount; }
      if (d && !date) date = `${tashkentYear}-${d[2]}-${d[1]}`;
      if (fn && !firmId) firmId = firms.find((f) => f.name === fn[1].trim())?.id;
    }
  }
  if (!found.length) {
    if (!date) {
      if (isPrivate) await reply("Qaysi to'lovni bekor qilay? Sana bilan yozing: «otkaz perech 04.10» yoki «otkaz naqd 04.10 500$».");
      return;
    }
    let q = `entries?kind=eq.payment&date=eq.${date}&select=*&order=created_at.asc`;
    if (method) q += `&method=eq.${method}`;
    if (firmId) q += `&firm=eq.${firmId}`;
    found = (await rest(q)).map(rowToEntry);
    if (amount) found = found.filter((e) => Math.abs((e.amount || 0) - amount!) < 0.01 || Math.abs((e.sumUzs || -1) - amount!) < 1);
  }

  if (found.length === 0) return void await reply("Bu sanada bunday to'lov topilmadi.");
  if (found.length > 1) {
    const list = found.map((e, i) => `${i + 1}) ${firmName(e.firm)} · ${METHOD_LABEL[e.method!]} ${fmt(e.amount!)} $ ${e.note || ""}`.trim()).join("\n");
    return void await reply(`Bir nechta to'lov topildi:\n${list}\n\nFirma va summasi bilan qayta yozing, masalan «otkaz ${firmName(found[0].firm).toLowerCase()} naqd ${ddmm(found[0].date)} ${fmt(found[0].amount!)}$».`);
  }
  const e = found[0];
  await deleteEntry(e.id);
  await reply(`❌ ${METHOD_LABEL[e.method!]} ${fmt(e.amount!)} $ (${ddmm(e.date)}) · ${firmName(e.firm)} bekor qilindi`);
}

// ---------- qoldiq ----------
async function balance(chatId: number, text: string) {
  const firms = await listFirms();
  const entries = await listEntries();
  const asked = norm(text.replace(BALANCE_RE, ""));
  const pick = asked ? firms.filter((f) => norm(f.name).startsWith(asked) || f.id.startsWith(asked)) : firms;
  if (!pick.length) return void await send(chatId, `«${asked}» degan firma yo'q. Firmalar: ${firms.map((f) => f.name).join(", ")}`);
  const blocks = pick.map((f) => {
    const s = summary(entries.filter((e) => e.firm === f.id));
    const head = s.balance >= 0
      ? `📊 ${f.name}: ${fmt(s.balance)} $ qarzimiz`
      : `📊 ${f.name}: ${fmt(-s.balance)} $ ortiqcha to'langan`;
    return `${head}\nYuklar: ${fmt(s.ship)} $ · Naqd: ${fmt(s.naqd)} $ · Perech: ${fmt(s.perech)} $`;
  });
  await send(chatId, `${blocks.join("\n\n")}\n\n${tashkentNow()}`);
}

// ---------- shipments ----------
async function isPoster(from: any, firm: Firm): Promise<boolean> {
  const posters = (firm.poster_ids || []).map(Number);
  if (posters.includes(from.id)) return true;
  const name = [from.first_name, from.last_name, from.username].filter(Boolean).join(" ");
  if (!posters.length && firm.poster_name && new RegExp(firm.poster_name, "i").test(name)) {
    await updateFirm(firm.id, { poster_ids: [from.id] });
    return true;
  }
  return false;
}

async function shipment(msg: any, text: string, firm: Firm): Promise<boolean> {
  const from = msg.from || {};
  if (!text || !(await isPoster(from, firm))) return false;

  const lists = parseShipments(text);
  if (!lists.length) return false;
  const prices = await priceMap(firm);
  const base = docId(msg.chat.id, msg.message_id);
  for (const [i, l] of lists.entries()) {
    const items = l.items.map((it) => ({ ...it, price: prices[norm(it.name)] || 0 }));
    const { gross, total } = shipmentTotals(items, firm.discount_pct);
    await upsertEntry({
      id: lists.length > 1 ? `${base}-${i + 1}` : base,
      firm: firm.id,
      kind: "shipment",
      date: l.date || tashkentDate(msg.date),
      note: l.note,
      items,
      total,
      gross,
      discountPct: Number(firm.discount_pct) || 0,
      createdAt: msg.date * 1000 + i,
      source: "telegram",
      sender: [from.first_name, from.last_name].filter(Boolean).join(" "),
    });
  }
  const t = await getMeta("telegram");
  await setMeta("telegram", { ...t, lastRun: new Date().toISOString(), lastError: "", lastShipmentAt: new Date().toISOString() });
  return true;
}

// The firm's price list first, then the latest positive price seen in its earlier shipments.
async function priceMap(firm: Firm): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const rows = await rest(`entries?firm=eq.${encodeURIComponent(firm.id)}&kind=eq.shipment&select=items&order=date.asc,created_at.asc`);
  for (const r of rows) for (const it of r.items || []) if (it.price > 0) map[norm(it.name)] = it.price;
  const p = firm.prices || {};
  for (const k of Object.keys(p)) if (p[k] > 0) map[norm(k)] = p[k];
  return map;
}

// ---------- photo lists (Doctor: handwritten, one list per counterparty) ----------
function background(p: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime;
  const safe = p.catch((err) => console.error("photo", err));
  if (rt?.waitUntil) rt.waitUntil(safe);
  else return safe;
}

async function notifyOwners(text: string) {
  for (const id of OWNER_IDS) await send(id, text).catch(() => {});
}

async function photoShipment(msg: any, firm: Firm) {
  if (!(await isPoster(msg.from || {}, firm))) return;
  if (!hasOcrKey()) {
    return void await notifyOwners(`📷 «${firm.name}» guruhida rasm keldi, lekin uni o'qish uchun Claude API kaliti hali qo'yilmagan.`);
  }
  // Reading a photo takes a while; answer Telegram now and finish in the background.
  await background(readPhoto(msg, firm));
}

async function readPhoto(msg: any, firm: Firm) {
  const sizes = msg.photo;
  const { bytes, mediaType } = await downloadFile(sizes[sizes.length - 1].file_id);
  const prices = await priceMap(firm);
  let lists;
  try {
    lists = await readListPhoto(bytesToBase64(bytes), mediaType, Object.keys(firm.prices || {}));
  } catch (err) {
    console.error(err);
    return void await notifyOwners(`📷 «${firm.name}»: rasmni o'qib bo'lmadi (${String(err).slice(0, 120)}). Ilovada qo'lda kiriting.`);
  }
  if (!lists.length) return void await notifyOwners(`📷 «${firm.name}»: rasmda ro'yxat topilmadi.`);
  const base = docId(msg.chat.id, msg.message_id);
  const lines: string[] = [];
  let sum = 0;
  for (const [i, l] of lists.entries()) {
    const items = l.items.map((it) => ({ ...it, price: prices[norm(it.name)] || 0 }));
    const { gross, total } = shipmentTotals(items, firm.discount_pct);
    const date = l.date || tashkentDate(msg.date);
    await upsertEntry({
      id: `${base}-${i + 1}`,
      firm: firm.id,
      kind: "shipment",
      date,
      note: l.counterparty,
      items,
      total,
      gross,
      discountPct: Number(firm.discount_pct) || 0,
      createdAt: msg.date * 1000 + i,
      source: "telegram",
      sender: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "),
    });
    sum += total;
    const noPrice = items.filter((it) => !it.price).length;
    const qty = items.reduce((s, it) => s + it.qty, 0);
    lines.push(`• ${l.counterparty || "?"} (${ddmm(date)}): ${items.length} xil, ${fmt(qty)} dona/k → ${fmt(total)} $${noPrice ? ` (${noPrice} tasi narxsiz)` : ""}`);
  }
  const t = await getMeta("telegram");
  await setMeta("telegram", { ...t, lastRun: new Date().toISOString(), lastError: "", lastShipmentAt: new Date().toISOString() });
  const disc = firm.discount_pct ? `, −${fmt(firm.discount_pct)}% bilan` : "";
  await notifyOwners(`📷 «${firm.name}» rasmi o'qildi${disc}:\n${lines.join("\n")}\nJami: ${fmt(sum)} $\n\nXato bo'lsa ilovada «Tahrirlash» bilan tuzating.`);
}
