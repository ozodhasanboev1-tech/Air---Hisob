// Pure text parsers for the Telegram bot. No Deno APIs here, so they can be unit-tested with node.

export type Item = { name: string; qty: number; price: number };

// Lowercase, single spaces, and Cyrillic letters that look Latin folded to Latin, so that a handwritten
// "750х" (Cyrillic) matches a price typed as "750x".
const LOOKALIKE: Record<string, string> = { а: "a", б: "b", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };
export const norm = (s: string) =>
  String(s).toLowerCase().replace(/[абвекмнорстух]/g, (c) => LOOKALIKE[c]).replace(/\s+/g, " ").trim();

// "5 000 000", "5.000.000", "785", "785.50", "1,5" -> number
export function parseAmount(raw: string): number {
  let s = raw.replace(/[\s ]/g, "");
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (dots + commas === 0) return Number(s);
  if (dots > 1 || commas > 1 || (dots && commas)) {
    // several separators: the last one is decimal only if followed by 1-2 digits
    const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    const tail = s.slice(last + 1);
    if (tail.length <= 2) return Number(s.slice(0, last).replace(/[.,]/g, "") + "." + tail);
    return Number(s.replace(/[.,]/g, ""));
  }
  // one separator: exactly 3 digits after it means thousands
  const [a, b] = s.split(/[.,]/);
  return b.length === 3 ? Number(a + b) : Number(a + "." + b);
}

// ---------- shipment lists ----------
// Air (Бобур): "Bozorga\nOsvejitel - 200 k\nAir sprey - 15 k" -> one list, destination as note.
// Doctor (typed): "Мухиддин 3.10.26\n750х - 10\n..." possibly several lists, each headed by a name and date.
export type ShipmentList = { note: string; date: string | null; items: { name: string; qty: number }[] };

const DATE_RE = /(\d{1,2})[./](\d{1,2})[./](\d{2,4})/;

export function parseShipments(text: string): ShipmentList[] {
  const lists: ShipmentList[] = [];
  let cur: ShipmentList = { note: "", date: null, items: [] };
  const dest: string[] = [];
  const close = () => {
    if (cur.items.length) lists.push({ ...cur, note: cur.note || dest.join(", ") });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-–—•*·▪️✅➖🔹🔸]+/u, "").trim();
    if (!line) continue;
    const d = line.match(DATE_RE);
    if (d) {
      // A header: "<counterparty> <date>". Starts a new list.
      close();
      dest.length = 0;
      let y = Number(d[3]);
      if (y < 100) y += 2000;
      cur = {
        note: line.replace(d[0], " ").replace(/\s+/g, " ").trim(),
        date: `${y}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`,
        items: [],
      };
      continue;
    }
    const m = line.match(/^(.*?)[\s:=\-–—]+(\d[\d\s.,]*)\s*(k|к|ta|та|шт|kor|кор|karobka|коробка)?\.?\s*$/iu);
    if (m && m[1].trim()) {
      const qty = parseAmount(m[2]);
      if (qty > 0) {
        cur.items.push({ name: m[1].replace(/[\s:=\-–—]+$/, "").trim(), qty });
        continue;
      }
    }
    if (!/\d/.test(line)) {
      if (cur.items.length && !cur.date) { close(); cur = { note: "", date: null, items: [] }; dest.length = 0; }
      if (!cur.date) dest.push(line);
    }
  }
  close();
  return lists;
}

// Single-list form kept for callers that only need items + note.
export function parseShipment(text: string): { items: { name: string; qty: number }[]; note: string } {
  const lists = parseShipments(text);
  return { items: lists.flatMap((l) => l.items), note: lists.map((l) => l.note).filter(Boolean).join(", ") };
}

// ---------- payments ----------
const METHOD_RE = "(naqd|нақд|накд|наличка|nalichka|perechisleniya|perechislenie|perech|перечисление|переч|bank|банк)";
const methodOf = (w: string): "naqd" | "perechisleniya" =>
  /^(naqd|нақд|накд|наличка|nalichka)$/i.test(w) ? "naqd" : "perechisleniya";

const NUM = "(\\d[\\d\\s.,]*\\d|\\d)";
const MULT = "(mln|млн|million|ming|минг|тыс|k)?";
const SOM_RE = /(so['‘’`ʻ]?m|сум|сўм|uzs)/i;
const USD_RE = /(\$|dollar|доллар|usd|долл)/i;

export type Payment = {
  method: "naqd" | "perechisleniya";
  amount?: number; // USD
  sumUzs?: number;
  rate?: number;
  note: string;
  needRate?: boolean;
};

function applyMult(n: number, mult?: string) {
  if (!mult) return n;
  if (/^(mln|млн|million)$/i.test(mult)) return n * 1_000_000;
  return n * 1000;
}

export function parsePayment(text: string): Payment | null {
  let t = text.trim().replace(/^#/, "").replace(/^(to['‘’`ʻ]?lov|тўлов|оплата)\s*[:\-]?\s*/i, "");
  // kurs first, so its number is not taken as the amount
  let rate: number | undefined;
  t = t.replace(/(kurs|курс)\s*[:=]?\s*(\d[\d\s.,]*\d|\d)/i, (_, _k, n) => {
    rate = parseAmount(n);
    return " ";
  });
  let method: string, num: string, mult: string | undefined, rest: string;
  let m = t.match(new RegExp(`^${METHOD_RE}\\s*[:\\-]?\\s*\\$?\\s*${NUM}\\s*${MULT}(?=\\s|$|\\$|[a-zа-яʻ'])(.*)$`, "isu"));
  if (m) {
    [, method, num, mult, rest] = m;
  } else {
    m = t.match(new RegExp(`^\\$?\\s*${NUM}\\s*${MULT}\\s*(\\$|dollar|usd|so['‘’\`ʻ]?m|сум|сўм)?\\s+${METHOD_RE}(?=\\s|$)(.*)$`, "isu"));
    if (!m) return null;
    let cur: string | undefined;
    [, num, mult, cur, method, rest] = m;
    rest = (cur || "") + " " + rest;
  }
  const value = applyMult(parseAmount(num), mult);
  if (!(value > 0)) return null;
  const isUsd = USD_RE.test(rest) || /\$/.test(t.slice(0, 40));
  const isSom = SOM_RE.test(rest) || (!isUsd && value >= 100_000);
  const note = rest
    .replace(/\$|\b(dollar|usd)\b|доллар|so['‘’`ʻ]?m\b|сум|сўм|\buzs\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  if (isSom) {
    if (!rate) return { method: methodOf(method), sumUzs: value, note, needRate: true };
    return { method: methodOf(method), sumUzs: value, rate, amount: Math.round((value / rate) * 100) / 100, note };
  }
  return { method: methodOf(method), amount: value, note };
}

// ---------- otkaz (cancel a payment) ----------
export const CANCEL_RE = /^\/?(otkaz|отказ|bekor|o['‘’`ʻ]?chir|ўчир|удали)(?![\p{L}])/iu;

export function parseCancel(text: string, nowYear: number) {
  const t = text.replace(CANCEL_RE, "").trim();
  const d = t.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  let date: string | undefined;
  if (d) {
    let y = d[3] ? Number(d[3]) : nowYear;
    if (y < 100) y += 2000;
    date = `${y}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
  }
  const mm = t.match(new RegExp(METHOD_RE, "i"));
  const rest = d ? t.replace(d[0], " ") : t;
  const a = rest.match(/(\d[\d\s.,]*\d|\d)\s*\$?/);
  return { date, method: mm ? methodOf(mm[1]) : undefined, amount: a ? parseAmount(a[1]) : undefined };
}

export const BALANCE_RE = /^\/?(qoldiq|қолдиқ|колдик|остаток|balans|баланс|qarz|қарз)(?![\p{L}])/iu;
