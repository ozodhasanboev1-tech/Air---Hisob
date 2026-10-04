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
  kind: "shipment" | "payment";
  date: string;
  note: string;
  items?: { name: string; qty: number; price: number }[];
  total?: number;
  method?: "naqd" | "perechisleniya" | null;
  amount?: number;
  sumUzs?: number | null;
  rate?: number | null;
  createdAt: number;
  source?: string;
  sender?: string | null;
};

export function rowToEntry(r: any): Entry {
  return {
    id: r.id, kind: r.kind, date: r.date, note: r.note ?? "",
    items: r.items ?? [], total: Number(r.total) || 0,
    method: r.method, amount: Number(r.amount) || 0,
    sumUzs: r.sum_uzs == null ? null : Number(r.sum_uzs),
    rate: r.rate == null ? null : Number(r.rate),
    createdAt: Number(r.created_at), source: r.source, sender: r.sender,
  };
}

export function entryToRow(e: Entry): Record<string, unknown> {
  const isShip = e.kind === "shipment";
  return {
    id: e.id, kind: e.kind, date: e.date, note: e.note ?? "",
    items: isShip ? e.items ?? [] : [],
    total: isShip ? e.total ?? 0 : 0,
    method: isShip ? null : e.method,
    amount: isShip ? 0 : e.amount ?? 0,
    sum_uzs: isShip ? null : e.sumUzs ?? null,
    rate: isShip ? null : e.rate ?? null,
    source: e.source ?? "app",
    sender: e.sender ?? null,
    created_at: e.createdAt ?? Date.now(),
    updated_at: new Date().toISOString(),
  };
}

export async function listEntries(): Promise<Entry[]> {
  const rows = await rest("entries?select=*&order=date.asc,created_at.asc");
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
