// Warehouse (sklad) posts, for firms kept as stock in boxes rather than money (SA Turkmenistan).
// No Deno APIs here, so it can be unit-tested with node.
//
//   15.10.26                 <- date (optional; the post's own date otherwise)
//   Мухаммад Али Андижон     <- customer, or «Prixod» / «Vozvrat Алишер»
//   Са 5л.     290           <- SKU and boxes
//   Са спрей.  20
//   70 ta                    <- no SKU means 5л (owner, 18.10.2026)

export type SkladKind = "out" | "in" | "return";
export type SkladItem = { sku: string; qty: number; doubt?: string };
export type SkladDoc = { kind: SkladKind; date: string | null; party: string; items: SkladItem[] };

export const DEFAULT_SKU = "5л";
export const KIND_LABEL: Record<SkladKind | "opening", string> = {
  out: "Chiqim", in: "Prixod", return: "Vozvrat", opening: "Ostatka",
};

const DATE_LINE = /^\s*(\d{1,2})[./,](\d{1,2})[./,](\d{2,4})\s*(?:й\.?|y\.?|yil)?\s*$/i;
const IN_RE = /^(prix|прих|приx|kirim|кирим|kelgan|келган)/i;
const RET_RE = /^(vozv|возв|vazv|qaytd|qaytar|қайт|кайт)/i;
// Brand prefix: Cyrillic «Са», Latin «SA», or a Latin «C» standing in for «С».
const BRAND_RE = /^(?:са|sa|ca|сa|cа)(?![\p{L}])\.?\s*/iu;
// "<anything> <qty> [ta|k|kor…]" with the quantity separated from what precedes it.
const QTY_TAIL = /^(.*?)(?:^|[\s\-–—:=])(\d+)\s*(?:ta|та|т|k|к|kor\w*|кор\w*|шт|sht)?\.?\s*$/iu;

export function parseDateLine(line: string): string | null {
  const m = line.match(DATE_LINE);
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  let y = +m[3];
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// "5л.", "5", "5 l", "1.5.", "1,5л", "3л к/н.", "спрей." -> "5л", "1.5л", "3л к/н", "спрей"
export function skuKey(raw: string): string {
  let t = raw.toLowerCase().replace(BRAND_RE, "").replace(/,/g, ".").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!t) return DEFAULT_SKU;
  if (/^(спр|spr|сpr)/.test(t)) return "спрей";
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(?:л|l|литр|litr)?\.?\s*(.*)$/);
  if (!m) return t;
  const tail = m[2].replace(/[.\s]/g, "").replace(/k/g, "к").replace(/n/g, "н");
  return `${m[1]}л${tail ? " " + tail : ""}`;
}

type Line = { sku: string; qty: number } | null;

// An item line: optional brand + SKU, then the box count; a bare count means 5л.
export function parseItemLine(line: string): Line {
  const s = line.trim();
  const m = s.match(QTY_TAIL);
  if (!m) return null;
  const prefix = m[1].trim();
  const qty = Number(m[2]);
  if (!qty) return null;
  if (!prefix) return { sku: DEFAULT_SKU, qty };
  if (BRAND_RE.test(prefix) || /^\d/.test(prefix) || /^(спр|spr)/i.test(prefix)) {
    // "SA5 70": brand glued to the volume.
    return { sku: skuKey(prefix.replace(/^(са|sa|ca)(?=\d)/i, "")), qty };
  }
  return null;
}

export function parseSklad(text: string): SkladDoc[] {
  const docs: SkladDoc[] = [];
  let date: string | null = null;
  let cur = null as SkladDoc | null;
  const start = (kind: SkladKind, party: string) => {
    if (cur?.items.length) docs.push(cur);
    cur = { kind, date, party, items: [] };
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const d = parseDateLine(line);
    if (d) {
      if (cur?.items.length) { docs.push(cur); cur = null; }
      date = d;
      if (cur) cur.date = d;
      continue;
    }
    // «Prixod 1170 ta» / «Vozvrat Алишер» on one line.
    const word = line.split(/[\s:]+/)[0];
    if (IN_RE.test(word) || RET_RE.test(word)) {
      const kind: SkladKind = IN_RE.test(word) ? "in" : "return";
      const rest = line.slice(word.length).replace(/^[\s:\-–—]+/, "");
      const item = rest ? parseItemLine(rest) : null;
      start(kind, kind === "in" ? "Prixod" : (item ? "" : rest));
      if (item) cur!.items.push(item);
      continue;
    }
    const item = parseItemLine(line);
    if (item) {
      if (!cur) start("out", "");
      cur!.items.push(item);
      continue;
    }
    // Any other line names the customer (or, right after «Vozvrat», who returned it).
    if (cur && !cur.items.length) cur.party = cur.party ? `${cur.party} ${line}` : line;
    else start("out", line);
  }
  if (cur?.items.length) docs.push(cur);
  return docs;
}

// Stock per SKU from documents: opening + prixod + vozvrat − chiqim.
export function stockOf(docs: { kind: string; items: { sku: string; qty: number }[] }[]): Record<string, number> {
  const s: Record<string, number> = {};
  for (const d of docs) {
    const sign = d.kind === "out" ? -1 : 1;
    for (const it of d.items || []) s[it.sku] = (s[it.sku] || 0) + sign * Number(it.qty || 0);
  }
  return s;
}

export function itemsText(items: SkladItem[]) {
  return items.map((i) => `${i.sku} ${i.qty}`).join(", ");
}

// The firm's SKU list (firms.skus): {"гель 5л (баклажка)": {code: "00001", aliases: ["5л"]}, …}.
// What a post says («Са 5л») is mapped to the catalogue name; unknown SKUs stay as written.
export type Catalog = Record<string, { code?: string; aliases?: string[] }>;
const flat = (s: string) => s.toLowerCase().replace(/[\s.()-]/g, "").replace(/,/g, ".");
export function canonical(sku: string, catalog: Catalog): string {
  const f = flat(sku);
  for (const [name, c] of Object.entries(catalog || {})) {
    if (flat(name) === f || (c.aliases || []).some((a) => flat(a) === f)) return name;
  }
  return sku;
}
