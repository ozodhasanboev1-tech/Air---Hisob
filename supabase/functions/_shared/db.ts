// Small helpers shared by the edge functions: PostgREST access with the service role key,
// row <-> entry mapping, number formatting and Tashkent dates.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export type Entry = {
  id: string;
  firm: string;
  kind: "shipment" | "payment";
  date: string;
  note: string;
  items?: { name: string; qty: number; price: number }[];
  total?: number;
  gross?: number | null;
  discountPct?: number | null;
  method?: "naqd" | "perechisleniya" | null;
  amount?: number;
  sumUzs?: number | null;
  rate?: number | null;
  createdAt: number;
  source?: string;
  sender?: string | null;
  original?: {
    text?: string; photo?: string; from?: string; at?: number;
    editedAt?: number; deletedAt?: number; history?: { text: string; at?: number }[];
  } | null;
};

export function rowToEntry(r: any): Entry {
  return {
    id: r.id, firm: r.firm, kind: r.kind, date: r.date, note: r.note ?? "",
    items: r.items ?? [], total: Number(r.total) || 0,
    gross: r.gross == null ? null : Number(r.gross),
    discountPct: r.discount_pct == null ? null : Number(r.discount_pct),
    method: r.method, amount: Number(r.amount) || 0,
    sumUzs: r.sum_uzs == null ? null : Number(r.sum_uzs),
    rate: r.rate == null ? null : Number(r.rate),
    createdAt: Number(r.created_at), source: r.source, sender: r.sender,
    original: r.original ?? null,
  };
}

export function entryToRow(e: Entry): Record<string, unknown> {
  const isShip = e.kind === "shipment";
  return {
    id: e.id, firm: e.firm || "air", kind: e.kind, date: e.date, note: e.note ?? "",
    items: isShip ? e.items ?? [] : [],
    total: isShip ? e.total ?? 0 : 0,
    gross: isShip ? e.gross ?? null : null,
    discount_pct: isShip ? e.discountPct ?? null : null,
    method: isShip ? null : e.method,
    amount: isShip ? 0 : e.amount ?? 0,
    sum_uzs: isShip ? null : e.sumUzs ?? null,
    rate: isShip ? null : e.rate ?? null,
    source: e.source ?? "app",
    sender: e.sender ?? null,
    created_at: e.createdAt ?? Date.now(),
    updated_at: new Date().toISOString(),
    // Left out unless set, so edits from the app keep the stored original.
    ...(e.original !== undefined ? { original: e.original } : {}),
  };
}

// ---------- storage: original photos ----------
export async function storePhoto(path: string, bytes: Uint8Array, mediaType: string) {
  const res = await fetch(`${SB_URL}/storage/v1/object/originals/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": mediaType, "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${await res.text()}`);
  return path;
}

export async function loadPhoto(path: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const res = await fetch(`${SB_URL}/storage/v1/object/originals/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${await res.text()}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mediaType: res.headers.get("content-type") || "image/jpeg" };
}

export async function photoUrl(path: string, expiresIn = 3600): Promise<string> {
  const res = await fetch(`${SB_URL}/storage/v1/object/sign/originals/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`storage ${res.status}: ${JSON.stringify(data)}`);
  return `${SB_URL}/storage/v1${data.signedURL}`;
}

export async function listEntries(firm?: string): Promise<Entry[]> {
  const f = firm ? `firm=eq.${encodeURIComponent(firm)}&` : "";
  const rows = await rest(`entries?${f}select=*&order=date.asc,created_at.asc`);
  return rows.map(rowToEntry);
}

export async function upsertEntry(e: Entry) {
  return await rest("entries?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(entryToRow(e)),
  });
}

export async function deleteEntry(id: string) {
  return await rest(`entries?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getMeta(key: string): Promise<any> {
  const rows = await rest(`meta?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows[0]?.value ?? {};
}

export async function setMeta(key: string, value: unknown) {
  return await rest("meta?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

// "12 345.5" style: space thousands, up to 2 decimals.
export function fmt(n: number): string {
  const r = Math.round((n || 0) * 100) / 100;
  const a = Math.abs(r), i = Math.floor(a), f = Math.round((a - i) * 100);
  return (r < 0 ? "−" : "") + String(i).replace(/\B(?=(\d{3})+(?!\d))/g, " ") +
    (f ? "." + String(f).padStart(2, "0") : "");
}

// Tashkent is UTC+5 all year.
export function tashkentDate(unixSec: number): string {
  return new Date(unixSec * 1000 + 5 * 3600 * 1000).toISOString().slice(0, 10);
}
export function tashkentNow(): string {
  const d = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`;
}

export function summary(entries: Entry[]) {
  let ship = 0, naqd = 0, perech = 0;
  for (const e of entries) {
    if (e.kind === "shipment") ship += e.total || 0;
    else if (e.method === "perechisleniya") perech += e.amount || 0;
    else naqd += e.amount || 0;
  }
  return { ship, naqd, perech, balance: ship - naqd - perech };
}

// ---------- firms ----------
export type Firm = {
  id: string;
  name: string;
  chat_id: number | null;
  poster_ids: number[];
  poster_name: string | null;
  prices: Record<string, number>;
  discount_pct: number;
  sort: number;
};

export async function listFirms(): Promise<Firm[]> {
  return await rest("firms?select=*&order=sort.asc,created_at.asc");
}

export async function firmByChat(chatId: number): Promise<Firm | null> {
  const rows = await rest(`firms?chat_id=eq.${chatId}&select=*`);
  return rows[0] ?? null;
}

export async function updateFirm(id: string, patch: Partial<Firm>) {
  const rows = await rest(`firms?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  return rows[0] as Firm;
}

export async function createFirm(f: Partial<Firm> & { id: string; name: string }) {
  const rows = await rest("firms", { method: "POST", body: JSON.stringify(f) });
  return rows[0] as Firm;
}

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh",
  ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ў: "o", қ: "q", ғ: "g", ҳ: "h",
};
export function slugify(name: string): string {
  const s = name.toLowerCase().split("").map((c) => CYR[c] ?? c).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || `firma-${Date.now().toString(36)}`;
}

// Shipment money: gross = sum(qty * price); total = gross minus the firm's discount (e.g. 13% for Doctor).
export function shipmentTotals(items: { qty: number; price: number }[], discountPct: number) {
  const gross = Math.round(items.reduce((s, it) => s + it.qty * it.price, 0) * 100) / 100;
  const total = Math.round(gross * (1 - (discountPct || 0) / 100) * 100) / 100;
  return { gross, total };
}
