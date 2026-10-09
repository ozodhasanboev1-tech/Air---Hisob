// Reads a photo of a handwritten shipment list (Doctor: "Мухиддин 3.10.26 / 750х — 10 / ...").
// Uses Claude when the ANTHROPIC_API_KEY secret is set (the owner's choice: Gemini kept misreading),
// reading each photo at least twice (see readListPhoto),
// otherwise Google Gemini when GEMINI_API_KEY is set. GEMINI_MODEL overrides the Gemini model.

import Anthropic from "npm:@anthropic-ai/sdk";

export type PhotoItem = { name: string; qty: number; doubt?: string };
export type PhotoList = { counterparty: string; date: string | null; items: PhotoItem[] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lists"],
  properties: {
    lists: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["counterparty", "date", "items"],
        properties: {
          counterparty: { type: "string" },
          date: { type: ["string", "null"], description: "YYYY-MM-DD" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "qty", "unsure"],
              properties: {
                name: { type: "string" },
                qty: { type: "number" },
                unsure: { type: "boolean", description: "true if any digit of this line is overwritten, smudged or could be read two ways" },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM =
  "You transcribe photos of handwritten shipment lists from a wholesale business in Uzbekistan. " +
  "A photo holds one or more lists. Each list starts with a header line: a counterparty (customer) name, " +
  "often followed by a number (e.g. 'Д 95', 'Мухиддин 2'), then a date like 3.10.26 (day.month.year). " +
  "The number belongs to the counterparty name. Under the header are lines " +
  "'<product code> — <quantity>', the quantity being boxes. Product codes are short, e.g. 1000к, 1200сц, 1200т, 750х, 770, Б550, 2100х: " +
  "keep the digits and the Cyrillic letter suffix or prefix exactly as written, without spaces. " +
  "Return every list in the order it appears, the date as YYYY-MM-DD (null if missing), and each line's " +
  "code as name and the number after the dash as qty. Skip crossed-out lines. " +
  "Money depends on every quantity, so read each digit slowly. Handwritten 8 and 9, 1 and 7, 3 and 8, 0 and 6 " +
  "are easy to confuse, and the writer sometimes corrects a digit by writing over it: then the digit drawn last " +
  "(on top, usually with heavier ink) is the real one. Set unsure to true for any line where a digit is " +
  "overwritten, smudged or could be read two ways.";

export function hasOcrKey() {
  return !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY"));
}

function knownText(knownNames: string[]) {
  return knownNames.length
    ? `Known product codes for this supplier (use exactly these spellings when a line matches one): ${knownNames.join(", ")}.`
    : "";
}

// With Claude the photo is read twice independently, and a third time when the two reads disagree.
// The majority value is kept; every line where the reads differ or the model was unsure gets a `doubt`
// so the owner is told exactly which number to check.
export async function readListPhoto(base64: string, mediaType: string, knownNames: string[]): Promise<PhotoList[]> {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return mergeReads([cleanLists(await readWithGemini(base64, mediaType, knownNames))]);
  const read = () => readWithClaude(base64, mediaType, knownNames).then(cleanLists);
  const reads = await Promise.all([read(), read()]);
  if (!sameReads(reads[0], reads[1])) reads.push(await read());
  return mergeReads(reads);
}

const key = (s: string) => s.toLowerCase().replace(/[\s.-]/g, "");

function sameReads(a: PhotoList[], b: PhotoList[]) {
  const flat = (ls: PhotoList[]) => JSON.stringify(ls.map((l) => [key(l.counterparty), l.items.map((i) => [key(i.name), i.qty])]));
  return flat(a) === flat(b);
}

function mergeReads(reads: PhotoList[][]): PhotoList[] {
  // The read whose list/line layout most others share is the base; quantities are voted line by line.
  const shape = (ls: PhotoList[]) => JSON.stringify(ls.map((l) => l.items.map((i) => key(i.name))));
  const base = reads.find((r) => reads.filter((o) => shape(o) === shape(r)).length > 1) || reads[0];
  return base.map((list, li) => ({
    ...list,
    items: list.items.map((item, ii) => {
      const match = (r: PhotoList[]) => {
        const items = r[li]?.items || [];
        return key(items[ii]?.name || "") === key(item.name) ? items[ii] : items.find((x) => key(x.name) === key(item.name));
      };
      const seen = reads.map((r) => match(r)?.qty);
      const counts = new Map<number, number>();
      for (const q of seen) if (q !== undefined) counts.set(q, (counts.get(q) || 0) + 1);
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const qty = best && best[1] > 1 ? best[0] : item.qty;
      const unsure = reads.some((r) => (match(r) as any)?.unsure);
      const others = [...counts.keys()].filter((q) => q !== qty);
      const missing = seen.some((q) => q === undefined);
      const doubt = others.length ? `${qty} yoki ${others.join(" / ")}?`
        : unsure ? `${qty} aniq emas`
        : missing ? "bu qator bir o'qishda chiqmadi"
        : undefined;
      return doubt ? { name: item.name, qty, doubt } : { name: item.name, qty };
    }),
  }));
}

// Gemini's response schema is an OpenAPI subset: no additionalProperties, nullable instead of type unions.
const GEMINI_SCHEMA = {
  type: "OBJECT",
  required: ["lists"],
  properties: {
    lists: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["counterparty", "date", "items"],
        properties: {
          counterparty: { type: "STRING" },
          date: { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              required: ["name", "qty"],
              properties: { name: { type: "STRING" }, qty: { type: "NUMBER" } },
            },
          },
        },
      },
    },
  },
};

async function readWithGemini(base64: string, mediaType: string, knownNames: string[]) {
  const preferred = Deno.env.get("GEMINI_MODEL");
  // Free-tier models get "503 high demand" at busy hours: wait and retry, then try the next model.
  const models = preferred ? [preferred] : ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
  let lastError = "";
  for (const model of models) {
    for (const wait of [0, 3000, 8000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{
            role: "user",
            parts: [
              { inline_data: { mime_type: mediaType, data: base64 } },
              { text: `Transcribe the shipment lists in this photo. ${knownText(knownNames)}` },
            ],
          }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) { lastError = `Gemini model ${model} not found`; break; }
      if ([429, 500, 503].includes(res.status)) { lastError = `Gemini ${res.status}: ${data?.error?.message || "busy"}`; continue; }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || "error"}`);
      const text = (data.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("");
      if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "empty"})`);
      return JSON.parse(text);
    }
  }
  throw new Error(lastError);
}

async function readWithClaude(base64: string, mediaType: string, knownNames: string[]) {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: base64 } },
        { type: "text", text: `Transcribe the shipment lists in this photo. ${knownText(knownNames)}` },
      ],
    }],
  } as any);
  if ((response as any).stop_reason === "refusal") throw new Error("OCR refused");
  const text = (response.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

function cleanLists(parsed: any): PhotoList[] {
  return (parsed?.lists || [])
    .map((l: any) => ({
      counterparty: String(l.counterparty || "").trim(),
      date: typeof l.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : null,
      items: (l.items || [])
        .map((i: any) => ({ name: String(i.name || "").trim(), qty: Number(i.qty) || 0, unsure: !!i.unsure }))
        .filter((i: any) => i.name && i.qty > 0),
    }))
    .filter((l: PhotoList) => l.items.length);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
