// Telegram webhook for @Air_Hisobi_bot.
// - Each firm (Air, Timson, ...) has its own Telegram group. Shipment lists posted there by the
//   firm's poster (Бобур for Air) become shipments of that firm.
// - The owner (OWNER_IDS) records payments (the bot asks which firm with buttons), cancels them
//   (otkaz), asks for the balance (qoldiq), links a group to a firm (/firma Nomi) and marks who
//   posts shipments (/yuk as a reply to that person's message).
// Telegram calls this URL with the X-Telegram-Bot-Api-Secret-Token header set by setWebhook.

import {
  createFirm, deleteEntry, Entry, Firm, firmByChat, fmt, getMeta, listEntries, listFirms, loadPhoto, rest, rowToEntry,
  setMeta, shipmentTotals, storePhoto, slugify, summary, tashkentDate, tashkentNow, updateFirm, upsertEntry,
} from "../_shared/db.ts";
import { downloadFile, send, tg } from "../_shared/telegram.ts";
import { bytesToBase64, hasOcrKey, readListPhoto } from "../_shared/ocr.ts";
import { canonical, itemsText, KIND_LABEL, parseSklad, SkladDoc, skuKey, stockOf } from "../_shared/sklad.ts";
import { BALANCE_RE, CANCEL_RE, norm, parseCancel, parsePayment, parseShipments, Payment } from "../_shared/parse.ts";

const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") || "";
const OWNER_IDS = (Deno.env.get("OWNER_IDS") || "6158024788").split(",").map((s) => Number(s.trim()));
const APP_URL = Deno.env.get("APP_URL") || "";

const METHOD_LABEL = { naqd: "Naqd", perechisleniya: "Perechisleniya" } as const;
const docId = (chatId: number, msgId: number) => `tg-${String(chatId).replace("-", "")}-${msgId}`;
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const FIRM_CMD_RE = /^\/?firma(?:@\w+)?\s+(.+)$/i;
const POSTER_CMD_RE = /^\/yuk(?:@\w+)?\s*$/i;
const SKLAD_RE = /^\/?(sklad|склад|ombor|омбор)(?![\p{L}])/iu;
const OSTATKA_RE = /^\/?(ostatka|остатка|ostatok)(?![\p{L}])/iu;

const HELP = [
  "Air hisob-kitobi boti.",
  "",
  "To'lov: «naqd 500$», «perech 785 $ Elyor uchun», «perech 5 000 000 so'm kurs 12650». Bot qaysi firmaga ekanini so'raydi. Firma nomini oldinga yozsangiz so'ramaydi: «timson naqd 500$».",
  "O'qilmagan rasmlar: «qayta o'qi»",
  "Bekor qilish: «otkaz perech 04.10» yoki «otkaz naqd 04.10 500$» (yoki ✅ xabariga javoban «otkaz»)",
  "Qoldiq: «qoldiq» (hamma firmalar) yoki «qoldiq timson»",
  "Ombor (SA): «sklad» — qoldiq va bugungi chiqim; «sklad 17.10» — o'sha kun",
  "Ombor ostatkasi: «ostatka» va keyingi qatorlarda «Са 5л 1000», «Са 2л 300» (sana qatori ixtiyoriy)",
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
    await background(maybeCheckDeleted());
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
  // Groups not linked to a firm: keep every message raw so its format can be studied first.
  if (isGroup && !firm && !(OWNER_IDS.includes(from.id) && FIRM_CMD_RE.test(text))) {
    return void await saveInbox(msg, !!update.edited_message).catch((e) => console.error("inbox", e));
  }
  if (isGroup && firm?.kind === "sklad") {
    if (OWNER_IDS.includes(from.id) && FIRM_CMD_RE.test(text)) return void await linkGroup(msg, text.match(FIRM_CMD_RE)![1].trim());
    return void await skladPost(msg, firm, !!update.edited_message);
  }
  if (isGroup && firm && msg.photo && !update.edited_message) {
    // Remember the group's latest photo so a bare «/yuk» can point at it.
    if (msg.from && !msg.from.is_bot) {
      await setMeta(`lastPhoto:${chat.id}`, { message_id: msg.message_id, date: msg.date, chat: { id: chat.id }, from: msg.from, photo: msg.photo });
    }
    return void await photoShipment(msg, firm);
  }
  // An edited photo post (new picture or caption): not re-read, but the owner is told.
  if (isGroup && firm && msg.photo && update.edited_message) return void await photoEdited(msg, firm);
  if (!text) return;

  if (OWNER_IDS.includes(from.id)) {
    if (isPrivate && /^\/(start|help|yordam)/i.test(text)) return void await send(chat.id, HELP);
    if (isGroup && FIRM_CMD_RE.test(text)) return void await linkGroup(msg, text.match(FIRM_CMD_RE)![1].trim());
    if (isGroup && POSTER_CMD_RE.test(text)) return void await markPoster(msg, firm);
    if (isPrivate && /^\/?qayta\b/i.test(text)) return void await rereadNow(chat.id);
    if (isPrivate && SKLAD_RE.test(text)) return void await skladReport(chat.id, text.replace(SKLAD_RE, ""));
    if (isPrivate && OSTATKA_RE.test(text)) return void await skladOpening(msg, text.replace(OSTATKA_RE, ""));
    if (isPrivate && BALANCE_RE.test(text)) return void await balance(chat.id, text);
    if (CANCEL_RE.test(text)) return void await cancel(msg, text, isPrivate);
    if (await payment(msg, text, isPrivate, firm, !!update.edited_message)) return;
    if (isPrivate) return void await send(chat.id, "Tushunmadim.\n\n" + HELP);
  }

  if (isGroup && firm) await shipment(msg, text, firm, !!update.edited_message);
}

// ---------- groups and firms ----------
async function saveInbox(msg: any, edited: boolean) {
  const f = msg.from || {};
  await rest("inbox?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      id: `${msg.chat.id}:${msg.message_id}${edited ? ":" + (msg.edit_date || 0) : ""}`,
      chat_id: msg.chat.id, chat_title: msg.chat.title ?? null, message_id: msg.message_id,
      date: new Date(msg.date * 1000).toISOString(), from_id: f.id ?? null,
      from_name: [f.first_name, f.last_name].filter(Boolean).join(" ") || f.username || null,
      text: msg.text || msg.caption || null, edited, raw: msg,
    }),
  });
}

async function onAddedToGroup(m: any) {
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const was = m.old_chat_member?.status, now = m.new_chat_member?.status;
  const joined = (was === "left" || was === "kicked") && (now === "member" || now === "administrator");
  if (!isGroup || !joined) return;
  const firm = await firmByChat(m.chat.id);
  if (!firm) await setMeta(`joined:${m.chat.id}`, { title: m.chat.title ?? null, at: new Date().toISOString(), by: m.from?.id ?? null });
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
  await send(chatId, firm.kind === "sklad"
    ? `✅ Bu guruh endi «${firm.name}» ombori. Chiqim, prixod va vozvratlar korobka bo'yicha hisoblanadi.`
    : `✅ Bu guruh endi «${firm.name}» hisobi.\nYuk ro'yxatini kim tashlasa, uning xabariga javoban «/yuk» deb yozing.`, msg.message_id);
}

async function markPoster(msg: any, firm: Firm | null) {
  const chatId = msg.chat.id;
  if (!firm) return void await send(chatId, "Avval guruhni firmaga bog'lang: «/firma Nomi».", msg.message_id);
  let r = msg.reply_to_message;
  // A quote-reply can arrive as external_reply (the original's author in origin.sender_user).
  if ((!r?.from || r.from.is_bot) && msg.external_reply?.origin?.sender_user) {
    const x = msg.external_reply;
    r = { ...x, from: x.origin.sender_user, chat: x.chat || msg.chat, message_id: x.message_id ?? msg.message_id, date: x.origin.date ?? msg.date };
  }
  // No usable reply at all: use the last photo posted in this group.
  if (!r?.from || r.from.is_bot) {
    const last = await getMeta(`lastPhoto:${chatId}`).catch(() => null);
    await setMeta("debug_yuk", {
      at: new Date().toISOString(), keys: Object.keys(msg), reply: msg.reply_to_message ? Object.keys(msg.reply_to_message) : null,
      replyFromBot: msg.reply_to_message?.from?.is_bot ?? null, replyFromId: msg.reply_to_message?.from?.id ?? null,
      external: msg.external_reply ? Object.keys(msg.external_reply) : null, hadLast: !!last?.from,
    }).catch(() => {});
    if (last?.from) r = last;
  }
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
  const pick = asked ? firms.filter((f) => norm(f.name).startsWith(asked) || f.id.startsWith(asked)) : firms.filter((f) => f.kind !== "sklad");
  if (pick.length && pick.every((f) => f.kind === "sklad")) return void await skladReport(chatId, asked.replace(/^\S+/, ""));
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

async function shipment(msg: any, text: string, firm: Firm, edited = false): Promise<boolean> {
  const from = msg.from || {};
  if (!text || !(await isPoster(from, firm))) return false;

  const base = docId(msg.chat.id, msg.message_id);
  // On an edit, the shipments this post produced before (one, or base-1, base-2… for several lists).
  const before: Entry[] = edited
    ? (await rest(`entries?or=(id.eq.${base},id.like.${base}-*)&select=*&order=created_at.asc`)).map(rowToEntry)
    : [];
  const lists = parseShipments(text);
  if (!lists.length) {
    if (before.length) {
      await notifyOwners(`✏️ «${firm.name}»: ${who(from)} ${when(msg.date)} dagi yuk xabarini o'zgartirdi, endi u yuk ro'yxatiga o'xshamaydi:\n«${text}»\n\nYozuv o'zgarmadi. Kerak bo'lsa ilovada tuzating yoki o'chiring.`);
    }
    return false;
  }
  if (edited && !before.length) {
    // Never recorded, or deleted in the app: record it as new, but say so.
    edited = false;
    await notifyOwners(`✏️ «${firm.name}»: ${who(from)} ${when(msg.date)} dagi xabarni o'zgartirdi. Bu yuk bazada yo'q edi, shuning uchun yangi yuk sifatida yozildi. Keragi bo'lmasa ilovada o'chiring.`);
  }

  const prev = before[0]?.original;
  const history = prev?.text && prev.text !== text
    ? [...(prev.history || []), { text: prev.text, at: prev.editedAt || prev.at }]
    : prev?.history || [];
  const original = {
    text, from: who(from), at: msg.date * 1000,
    ...(msg.edit_date ? { editedAt: msg.edit_date * 1000 } : {}),
    ...(history.length ? { history } : {}),
  };

  const prices = await priceMap(firm);
  const ids: string[] = [];
  const lines: string[] = [];
  for (const [i, l] of lists.entries()) {
    const items = l.items.map((it) => ({ ...it, price: prices[norm(it.name)] || 0 }));
    const { gross, total } = shipmentTotals(items, firm.discount_pct);
    const id = lists.length > 1 ? `${base}-${i + 1}` : base;
    ids.push(id);
    lines.push(`${l.note || "Yuk"}: ${l.items.map((it) => `${it.name} ${it.qty}`).join(", ")} = ${fmt(total)} $`);
    await upsertEntry({
      id,
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
      sender: who(from),
      original,
    });
  }
  // The post now holds fewer lists than before: drop the shipments it no longer has.
  for (const b of before) if (!ids.includes(b.id)) await deleteEntry(b.id);

  if (edited) {
    const was = before.reduce((s, b) => s + (b.total || 0), 0);
    const now = (await rest(`entries?or=(id.eq.${base},id.like.${base}-*)&select=total`))
      .reduce((s: number, r: any) => s + Number(r.total || 0), 0);
    await notifyOwners(`✏️ «${firm.name}»: ${who(from)} ${when(msg.date)} dagi yukni o'zgartirdi.\n`
      + `Oldin: ${fmt(was)} $\nEndi: ${fmt(now)} $\n${lines.join("\n")}\n\n`
      + `Bot yozuvni yangisiga almashtirdi; eski matn ilovada «Asli» ichida turibdi.`);
  }
  const t = await getMeta("telegram");
  await setMeta("telegram", { ...t, lastRun: new Date().toISOString(), lastError: "", lastShipmentAt: new Date().toISOString() });
  return true;
}

const who = (from: any) => [from.first_name, from.last_name].filter(Boolean).join(" ");
// "05.10 09:09" in Tashkent time.
function when(unixSec: number): string {
  const d = new Date(unixSec * 1000 + 5 * 3600 * 1000).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`;
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
  if (AUTO_OCR && !hasOcrKey()) {
    return void await notifyOwners(`📷 «${firm.name}» guruhida rasm keldi, lekin uni o'qish uchun ANTHROPIC_API_KEY hali qo'yilmagan.`);
  }
  // Reading a photo takes a while; answer Telegram now and finish in the background.
  await background(readPhoto(msg, firm));
}

async function readPhoto(msg: any, firm: Firm) {
  const sizes = msg.photo;
  const { bytes, mediaType } = await downloadFile(sizes[sizes.length - 1].file_id);
  const sender = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  // Keep the photo itself, exactly as posted, next to the shipments read from it.
  const ext = mediaType.includes("png") ? "png" : "jpg";
  const photo = await storePhoto(`${firm.id}/${docId(msg.chat.id, msg.message_id)}.${ext}`, bytes, mediaType)
    .catch((err) => (console.error("storePhoto", err), undefined));
  const original = { photo, text: (msg.caption || "").trim() || undefined, from: sender, at: msg.date * 1000 };
  if (!AUTO_OCR) {
    // Photos are read by Claude (a scheduled cloud session), not by the bot: keep an empty shipment
    // with the photo so the reader finds it, and tell the owner it is queued.
    const base = docId(msg.chat.id, msg.message_id);
    await upsertEntry({
      id: `${base}-1`, firm: firm.id, kind: "shipment", date: tashkentDate(msg.date), note: "📷 o'qilmagan rasm",
      items: [], total: 0, gross: 0, discountPct: Number(firm.discount_pct) || 0,
      createdAt: msg.date * 1000, source: "telegram", sender, original,
    });
    return void await notifyOwners(`📷 «${firm.name}»: ${sender} ${when(msg.date)} dagi rasm saqlandi. Claude uni o'qib, ro'yxatni kiritadi va shu yerga yozadi.`);
  }
  await ocrPhoto(firm, docId(msg.chat.id, msg.message_id), msg.date, sender, original, bytes, mediaType, false);
}

// The bot reads photos itself only with Claude (ANTHROPIC_API_KEY): Gemini was switched off at the
// owner's request. Without the key, photos wait for the hourly Claude session (scripts/photos.py).
const AUTO_OCR = !!Deno.env.get("ANTHROPIC_API_KEY");

// Reads one list photo into shipments `${base}-1`, `${base}-2`, …; an unread photo leaves one empty
// shipment (so the photo is kept and can be filled in the app), which the hourly job retries.
async function ocrPhoto(
  firm: Firm, base: string, unixDate: number, sender: string, original: any,
  bytes: Uint8Array, mediaType: string, retry: boolean,
): Promise<boolean> {
  const prices = await priceMap(firm);
  // A retry must never overwrite a shipment that was filled in meanwhile (in the app or by hand).
  const stillUnread = async () => {
    if (!retry) return true;
    const [row] = await rest(`entries?id=eq.${encodeURIComponent(`${base}-1`)}&select=note,items`);
    return !!row && row.note === "📷 o'qilmagan rasm" && !(row.items || []).length;
  };
  const unread = async (why: string) => {
    if (!(await stillUnread())) return;
    const tries = (original.ocrTries || 0) + 1;
    await upsertEntry({
      id: `${base}-1`, firm: firm.id, kind: "shipment", date: tashkentDate(unixDate), note: "📷 o'qilmagan rasm",
      items: [], total: 0, gross: 0, discountPct: Number(firm.discount_pct) || 0,
      createdAt: unixDate * 1000, source: "telegram", sender, original: { ...original, ocrTries: tries },
    });
    if (!retry) {
      await notifyOwners(`📷 «${firm.name}»: ${why}. Bot bir soatdan keyin yana urinib ko'radi; rasm ilovada saqlandi.`);
    } else if (tries >= RETRY_LIMIT) {
      await notifyOwners(`📷 «${firm.name}»: ${sender} ${when(unixDate)} dagi rasmni ${tries} marta o'qib bo'lmadi (${why}). Ro'yxatni ilovada qo'lda kiriting.`);
    }
  };
  let lists;
  try {
    lists = await readListPhoto(bytesToBase64(bytes), mediaType, Object.keys(firm.prices || {}));
  } catch (err) {
    console.error(err);
    await unread(`rasmni o'qib bo'lmadi (${String(err).slice(0, 120)})`);
    return false;
  }
  if (!lists.length) {
    await unread("rasmda ro'yxat topilmadi");
    return false;
  }
  if (!(await stillUnread())) return false;
  const { ocrTries: _, ...kept } = original;
  const lines: string[] = [];
  const doubts: string[] = [];
  let sum = 0;
  for (const [i, l] of lists.entries()) {
    for (const it of l.items) if (it.doubt) doubts.push(`• ${l.counterparty || "?"}: ${it.name} — ${it.doubt}`);
    const items = l.items.map(({ doubt: _d, ...it }) => ({ ...it, price: prices[norm(it.name)] || 0 }));
    const { gross, total } = shipmentTotals(items, firm.discount_pct);
    const date = l.date || tashkentDate(unixDate);
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
      createdAt: unixDate * 1000 + i,
      source: "telegram",
      sender,
      original: kept,
    });
    sum += total;
    const noPrice = items.filter((it) => !it.price).length;
    const qty = items.reduce((s, it) => s + it.qty, 0);
    lines.push(`• ${l.counterparty || "?"} (${ddmm(date)}): ${items.length} xil, ${fmt(qty)} k → ${fmt(total)} $${noPrice ? ` (${noPrice} tasi narxsiz)` : ""}`);
  }
  const t = await getMeta("telegram");
  await setMeta("telegram", { ...t, lastRun: new Date().toISOString(), lastError: "", lastShipmentAt: new Date().toISOString() });
  const disc = firm.discount_pct ? `, −${fmt(firm.discount_pct)}% bilan` : "";
  const head = retry ? `📷 «${firm.name}»: ${sender} ${when(unixDate)} dagi rasm qayta urinishda o'qildi${disc}` : `📷 «${firm.name}» rasmi o'qildi${disc}`;
  const check = doubts.length ? `\n\n⚠️ Rasmda shu sonlar aniq emas, tekshirib qo'ying:\n${doubts.join("\n")}` : "";
  await notifyOwners(`${head}:\n${lines.join("\n")}\nJami: ${fmt(sum)} $${check}\n\nXato bo'lsa ilovada «Tahrirlash» bilan tuzating.`);
  return true;
}

const RETRY_LIMIT = 5;

// «qayta o'qi» from the owner: retry unread photos right away instead of waiting for the hourly job.
async function rereadNow(chatId: number) {
  if (!AUTO_OCR) {
    const rows = await rest(`entries?kind=eq.shipment&note=eq.${encodeURIComponent("📷 o'qilmagan rasm")}&select=id`);
    return void await send(chatId, rows.length ? `📷 ${rows.length} ta rasm navbatda, Claude ularni o'qib kiritadi.` : "O'qilmagan rasm yo'q ✅");
  }
  const rows = await rest(`entries?kind=eq.shipment&note=eq.${encodeURIComponent("📷 o'qilmagan rasm")}&select=id`);
  if (!rows.length) return void await send(chatId, "O'qilmagan rasm yo'q ✅");
  await send(chatId, `🔄 ${rows.length} ta o'qilmagan rasmni qayta o'qiyapman, natijasini shu yerga yozaman.`);
  await background((async () => {
    await retryUnreadPhotos(true);
    const left = await rest(`entries?kind=eq.shipment&note=eq.${encodeURIComponent("📷 o'qilmagan rasm")}&select=id`);
    if (left.length) await send(chatId, `⏳ ${left.length} ta rasm hali o'qilmadi (o'qish xizmati band bo'lishi mumkin). Bot har soatda yana urinadi, yoki birozdan keyin yana «qayta o'qi» deb yozing.`);
  })());
}

// Photos left unread (OCR busy or down), retried once an hour from the same hourly job.
async function retryUnreadPhotos(manual = false) {
  if (!AUTO_OCR || !hasOcrKey()) return;
  const rows: Entry[] = (await rest(`entries?kind=eq.shipment&source=eq.telegram&note=eq.${encodeURIComponent("📷 o'qilmagan rasm")}&select=*&order=created_at.asc`))
    .map(rowToEntry)
    .filter((e: Entry) => e.original?.photo && !e.original?.deletedAt && !(e.items || []).length && (manual || ((e.original as any).ocrTries || 1) < RETRY_LIMIT));
  if (!rows.length) return;
  const firms = await listFirms();
  const started = Date.now();
  for (const e of rows) {
    if (Date.now() - started > 60_000) break; // stay well inside the function's time limit
    const firm = firms.find((f) => f.id === e.firm);
    if (!firm) continue;
    const { bytes, mediaType } = await loadPhoto(e.original!.photo!);
    await ocrPhoto(firm, e.id.replace(/-1$/, ""), Math.floor((e.original!.at || e.createdAt || Date.now()) / 1000),
      e.sender || e.original!.from || "", e.original, bytes, mediaType, true);
  }
}

async function photoEdited(msg: any, firm: Firm) {
  const from = msg.from || {};
  if (!(await isPoster(from, firm))) return;
  const base = docId(msg.chat.id, msg.message_id);
  const rows = await rest(`entries?or=(id.eq.${base},id.like.${base}-*)&select=id`);
  if (!rows.length) return;
  await notifyOwners(`✏️ «${firm.name}»: ${who(from)} ${when(msg.date)} dagi rasmli yukni o'zgartirdi.`
    + `\nBot rasmni qayta o'qimadi: ilovada «Asli» bilan solishtirib, kerak bo'lsa yukni tuzating.`);
}

// ---------- deleted posts ----------
// Runs at most once an hour, riding on whatever update arrives (the groups are busy enough).
async function maybeCheckDeleted() {
  const t = await getMeta("deletedCheck");
  if (t.at && Date.now() - Date.parse(t.at) < 3600_000) return;
  await setMeta("deletedCheck", { at: new Date().toISOString() });
  await checkDeleted().catch((err) => console.error("checkDeleted", err));
  await retryUnreadPhotos().catch((err) => console.error("retryUnreadPhotos", err));
}

// Telegram never tells a bot that a message was deleted. Clearing the bot's (absent) reaction on a
// post changes nothing that people can see, but fails with "message to react not found" once the post
// is gone, so it tells us which recent shipment posts were deleted.
async function checkDeleted(): Promise<number> {
  const since = tashkentDate(Date.now() / 1000 - 60 * 86400);
  const rows: Entry[] = (await rest(
    `entries?kind=eq.shipment&source=eq.telegram&id=like.tg-*&date=gte.${since}&select=*&order=created_at.asc`,
  )).map(rowToEntry).filter((e: Entry) => !e.original?.deletedAt);
  const posts = new Map<string, Entry[]>();
  for (const e of rows) {
    const m = e.id.match(/^tg-(\d+)-(\d+)(?:-\d+)?$/);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    posts.set(key, [...(posts.get(key) || []), e]);
  }
  const firms = await listFirms();
  for (const [key, list] of posts) {
    const [chat, msgId] = key.split("-").map(Number);
    const r = await tg("setMessageReaction", { chat_id: -chat, message_id: msgId, reaction: [] });
    if (r?.ok || !/message to react not found/i.test(r?.description || "")) continue;
    const at = Date.now();
    for (const e of list) {
      await rest(`entries?id=eq.${encodeURIComponent(e.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ original: { ...(e.original || {}), deletedAt: at } }),
      });
    }
    const e0 = list[0], o = e0.original || {};
    const firm = firms.find((f) => f.id === e0.firm)?.name || e0.firm;
    const sum = list.reduce((s, e) => s + (e.total || 0), 0);
    await notifyOwners(`🗑 «${firm}»: ${o.from || e0.sender || "yuk tashlovchi"} ${o.at ? when(o.at / 1000) : e0.date} dagi yuk xabarini Telegramdan o'chirdi.`
      + (o.text ? `\n«${o.text.slice(0, 300)}»` : o.photo ? "\n(rasm edi)" : "")
      + `\n\nIlovada bu yuk hali turibdi: ${fmt(sum)} $. Haqiqatan bekor bo'lgan bo'lsa, ilovada o'chiring.`);
  }
  return posts.size;
}

// ---------- ombor (sklad): SA Turkmenistan, boxes per SKU, no money ----------
type StockRow = { id: string; firm: string; kind: string; date: string; party: string; items: { sku: string; qty: number; doubt?: string }[]; created_at: number; original?: any };

const SKLAD_PHOTO_HINT =
  "This photo is a page of a warehouse notebook, not a price list. Each record: first line the date (dd.mm.yy), " +
  "next line the customer name — or «Приход»/«Prixod» for incoming stock, or «Возврат»/«Vozvrat» (then the customer) for a return — " +
  "then lines like «SA 5л 60», «SA 2л 30», «SA5 70»: the brand SA, a volume in litres, and the number of boxes. " +
  "Use the customer (or Приход / Возврат <customer>) as counterparty. Give each item name without the SA prefix, e.g. 5л, 2л, 1.5л, 3л к/н, спрей.";

async function stockRows(firmId: string): Promise<StockRow[]> {
  return await rest(`stock_docs?firm=eq.${encodeURIComponent(firmId)}&select=*&order=date.asc,created_at.asc`);
}

// Moves before the opening stock's date are already inside it, so they are kept but not counted.
function counted(rows: StockRow[]) {
  const opening = rows.find((r) => r.kind === "opening");
  return { opening, rows: rows.filter((r) => r.kind === "opening" || !opening || r.date >= opening.date) };
}

async function isSkladPoster(from: any, firm: Firm) {
  if (from.is_bot) return false;
  if ((firm.poster_ids || []).map(Number).includes(from.id)) return true;
  const name = [from.first_name, from.last_name, from.username].filter(Boolean).join(" ");
  return !!firm.poster_name && new RegExp(firm.poster_name, "i").test(name);
}

async function skladPost(msg: any, firm: Firm, edited: boolean) {
  const from = msg.from || {};
  if (!(await isSkladPoster(from, firm))) return;
  if (msg.photo) {
    if (edited) return void await notifyOwners(`✏️ «${firm.name}»: ${who(from)} ${when(msg.date)} dagi rasmni o'zgartirdi. Rasm qayta o'qilmadi, kerak bo'lsa menga ayting.`);
    return void await background(skladPhoto(msg, firm));
  }
  const text = (msg.text || "").trim();
  if (!text) return;
  const base = docId(msg.chat.id, msg.message_id);
  const before: StockRow[] = edited ? await rest(`stock_docs?id=like.${base}-*&select=*&order=created_at.asc`) : [];
  const docs = parseSklad(text);
  if (!docs.length) {
    if (before.length) await notifyOwners(`✏️ «${firm.name}»: ${who(from)} ${when(msg.date)} dagi xabarni o'zgartirdi, endi u ro'yxatga o'xshamaydi:\n«${text}»\nOmbordagi yozuv o'zgarmadi.`);
    return;
  }
  const prev = before[0]?.original;
  const history = prev?.text && prev.text !== text ? [...(prev.history || []), { text: prev.text, at: prev.editedAt || prev.at }] : prev?.history || [];
  const original = { text, from: who(from), at: msg.date * 1000, ...(msg.edit_date ? { editedAt: msg.edit_date * 1000 } : {}), ...(history.length ? { history } : {}) };
  await saveSklad(firm, base, docs, msg.date, who(from), original, before);
}

async function skladPhoto(msg: any, firm: Firm) {
  const base = docId(msg.chat.id, msg.message_id);
  const sender = who(msg.from || {});
  const sizes = msg.photo;
  const { bytes, mediaType } = await downloadFile(sizes[sizes.length - 1].file_id);
  const photo = await storePhoto(`${firm.id}/${base}.${mediaType.includes("png") ? "png" : "jpg"}`, bytes, mediaType)
    .catch((err) => (console.error("storePhoto", err), undefined));
  const original = { photo, text: (msg.caption || "").trim() || undefined, from: sender, at: msg.date * 1000 };
  if (!AUTO_OCR) return void await notifyOwners(`📷 «${firm.name}»: ${sender} ${when(msg.date)} dagi rasm saqlandi, lekin bot rasm o'qiy olmaydi (ANTHROPIC_API_KEY yo'q).`);
  const known = [...new Set([...Object.values(firm.skus || {}).flatMap((c) => c.aliases || []), ...(await stockRows(firm.id)).flatMap((r) => r.items.map((i) => i.sku))])];
  let lists;
  try {
    lists = await readListPhoto(bytesToBase64(bytes), mediaType, known, SKLAD_PHOTO_HINT);
  } catch (err) {
    console.error("sklad ocr", err);
    return void await notifyOwners(`📷 «${firm.name}»: ${sender} ${when(msg.date)} dagi rasmni o'qiy olmadim (${String(err).slice(0, 80)}). Iltimos, matn qilib yuboring.`);
  }
  const docs: SkladDoc[] = [];
  for (const l of lists) {
    // Reuse the text parser on the header so «Приход» / «Возврат Алишер» get the right kind.
    const head = parseSklad(`${l.counterparty}\n1`)[0] || { kind: "out", party: l.counterparty };
    docs.push({
      kind: head.kind, date: l.date, party: head.kind === "in" ? "Prixod" : head.party,
      items: l.items.map((i) => ({ sku: skuKey(i.name), qty: i.qty, ...(i.doubt ? { doubt: i.doubt } : {}) })),
    });
  }
  if (!docs.length) return void await notifyOwners(`📷 «${firm.name}»: ${sender} ${when(msg.date)} dagi rasmda ro'yxat topilmadi. Rasmni tekshiring.`);
  await saveSklad(firm, base, docs, msg.date, sender, original, []);
}

async function saveSklad(firm: Firm, base: string, docs: SkladDoc[], unixDate: number, sender: string, original: any, before: StockRow[]) {
  docs = docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, sku: canonical(i.sku, firm.skus || {}) })) }));
  const all = await stockRows(firm.id);
  const knownSkus = new Set([...Object.keys(firm.skus || {}), ...all.filter((r) => !r.id.startsWith(`${base}-`)).flatMap((r) => r.items.map((i) => i.sku))]);
  const ids: string[] = [];
  const lines: string[] = [];
  const warn: string[] = [];
  const opening = all.find((r) => r.kind === "opening");
  for (const [i, d] of docs.entries()) {
    const id = `${base}-${i + 1}`;
    const date = d.date || tashkentDate(unixDate);
    ids.push(id);
    await rest("stock_docs?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id, firm: firm.id, kind: d.kind, date, party: d.party, items: d.items, source: "telegram", sender, original, created_at: unixDate * 1000 + i, updated_at: new Date().toISOString() }),
    });
    lines.push(`${KIND_LABEL[d.kind]} ${ddmm(date)}${d.party && d.kind !== "in" ? ` — ${d.party}` : ""}: ${itemsText(d.items)}`);
    for (const it of d.items) {
      if (it.doubt) warn.push(`⚠️ ${d.party || KIND_LABEL[d.kind]}: ${it.sku} — ${it.doubt}`);
      if (!knownSkus.has(it.sku)) warn.push(`🆕 Yangi SKU «${it.sku}» — to'g'ri o'qilganmi?`);
    }
    if (opening && date < opening.date) warn.push(`ℹ️ Sana ${ddmm(date)} ostatkadan (${ddmm(opening.date)}) oldin — qoldiqqa qo'shilmadi.`);
    if (!d.party && d.kind === "out") warn.push("⚠️ Mijoz nomi yozilmagan.");
  }
  for (const b of before) if (!ids.includes(b.id)) await rest(`stock_docs?id=eq.${encodeURIComponent(b.id)}`, { method: "DELETE" });

  const stock = stockOf(counted(await stockRows(firm.id)).rows);
  const touched = [...new Set(docs.flatMap((d) => d.items.map((i) => i.sku)))];
  for (const k of touched) if ((stock[k] || 0) < 0 && opening) warn.push(`❗ ${k} qoldig'i manfiy: ${stock[k]}`);
  const head = before.length ? `✏️ «${firm.name}»: ${sender} ${when(unixDate)} dagi xabarni o'zgartirdi. Oldin: ${before.map((b) => itemsText(b.items)).join("; ")}` : `📦 «${firm.name}» · ${sender} ${when(unixDate)}`;
  await notifyOwners([
    head, ...lines, "",
    opening ? `Qoldiq: ${touched.map((k) => `${k} ${stock[k] || 0}`).join(" · ")}` : "Ostatka hali kiritilmagan, qoldiq hisoblanmadi.",
    ...(warn.length ? ["", ...warn] : []),
  ].join("\n"));
}

function skladFirm(firms: Firm[], hint: string) {
  const h = norm(hint);
  const sk = firms.filter((f) => f.kind === "sklad");
  return sk.find((f) => h && (norm(f.name) === h || f.id === h)) || sk[0];
}

async function skladReport(chatId: number, rest_: string) {
  const firm = skladFirm(await listFirms(), "");
  if (!firm) return void await send(chatId, "Ombor firmasi yo'q.");
  const day = rest_.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  const today = tashkentDate(Date.now() / 1000);
  const date = day ? `${day[3] ? (day[3].length === 2 ? "20" + day[3] : day[3]) : today.slice(0, 4)}-${day[2].padStart(2, "0")}-${day[1].padStart(2, "0")}` : today;
  const { opening, rows } = counted(await stockRows(firm.id));
  const stock = stockOf(rows);
  // Catalogue order first (as in the owner's stock list), then anything new.
  const skus = [...new Set([...Object.keys(firm.skus || {}), ...Object.keys(stock)])].filter((k) => k in stock);
  const dayRows = rows.filter((r) => r.date === date && r.kind !== "opening");
  const sum = (kind: string) => itemsText(Object.entries(stockOf(dayRows.filter((r) => r.kind === kind).map((r) => ({ kind: "in", items: r.items })))).map(([sku, qty]) => ({ sku, qty }))) || "—";
  const out = [
    `📦 ${firm.name} ombori`,
    opening ? `Qoldiq (korobka), ostatka ${ddmm(opening.date)} dan:` : "Ostatka hali kiritilmagan («ostatka» buyrug'i). Harakatlar yig'indisi:",
    ...(skus.length ? skus.map((k) => `  ${k} — ${fmt(stock[k])}`) : ["  —"]),
    "",
    `${ddmm(date)}: chiqim ${sum("out")} · prixod ${sum("in")} · vozvrat ${sum("return")}`,
    ...dayRows.map((r) => `  ${KIND_LABEL[r.kind as keyof typeof KIND_LABEL]}${r.party && r.kind !== "in" ? ` ${r.party}` : ""}: ${itemsText(r.items)}`),
    "",
    tashkentNow(),
  ];
  await send(chatId, out.join("\n"));
}

// «ostatka [SA]\n18.10.26\nСа 5л 1000\nСа 2л 300» — replaces the opening stock.
async function skladOpening(msg: any, body: string) {
  const firms = await listFirms();
  const [first, ...more] = body.split(/\r?\n/);
  const firm = skladFirm(firms, first.trim());
  if (!firm) return void await send(msg.chat.id, "Ombor firmasi yo'q.");
  // The first line may just name the firm («ostatka SA»); everything else is the list.
  const namesFirm = firms.some((f) => f.kind === "sklad" && norm(f.name) === norm(first.trim()));
  const docs = parseSklad((namesFirm ? "" : first + "\n") + more.join("\n"));
  const items: Record<string, number> = {};
  for (const d of docs) for (const it of d.items) {
    const k = canonical(it.sku, firm.skus || {});
    items[k] = (items[k] || 0) + it.qty;
  }
  if (!Object.keys(items).length) return void await send(msg.chat.id, "Ostatkani shunday yozing:\nostatka\n18.10.26\nСа 5л 1000\nСа 2л 300");
  const date = docs.find((d) => d.date)?.date || tashkentDate(msg.date);
  await rest("stock_docs?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: `${firm.id}-opening`, firm: firm.id, kind: "opening", date, party: "", items: Object.entries(items).map(([sku, qty]) => ({ sku, qty })), source: "telegram", sender: who(msg.from || {}), original: { text: body, at: msg.date * 1000 }, created_at: msg.date * 1000, updated_at: new Date().toISOString() }),
  });
  await skladReport(msg.chat.id, ddmm(date));
}
