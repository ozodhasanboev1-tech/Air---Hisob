// Reads a photo of a handwritten shipment list (Doctor: "Мухиддин 3.10.26 / 750х — 10 / ...").
// Uses Google Gemini when the GEMINI_API_KEY secret is set (a free AI Studio key, no billing needed),
// otherwise Claude when ANTHROPIC_API_KEY is set. GEMINI_MODEL overrides the Gemini model.

import Anthropic from "npm:@anthropic-ai/sdk";

export type PhotoList = { counterparty: string; date: string | null; items: { name: string; qty: number }[] };

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
              required: ["name", "qty"],
              properties: { name: { type: "string" }, qty: { type: "number" } },
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
  "code as name and the number after the dash as qty. Skip crossed-out lines.";

export function hasOcrKey() {
  return !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY"));
}

function knownText(knownNames: string[]) {
  return knownNames.length
    ? `Known product codes for this supplier (use exactly these spellings when a line matches one): ${knownNames.join(", ")}.`
    : "";
}

export async function readListPhoto(base64: string, mediaType: string, knownNames: string[]): Promise<PhotoList[]> {
  const parsed = Deno.env.get("GEMINI_API_KEY")
    ? await readWithGemini(base64, mediaType, knownNames)
    : await readWithClaude(base64, mediaType, knownNames);
  return cleanLists(parsed);
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
  const models = preferred ? [preferred] : ["gemini-flash-latest", "gemini-2.5-flash"];
  let lastError = "";
  for (const model of models) {
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
    if (res.status === 404) { lastError = `Gemini model ${model} not found`; continue; }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || "error"}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("");
    if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "empty"})`);
    return JSON.parse(text);
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
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
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
        .map((i: any) => ({ name: String(i.name || "").trim(), qty: Number(i.qty) || 0 }))
        .filter((i: any) => i.name && i.qty > 0),
    }))
    .filter((l: PhotoList) => l.items.length);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
