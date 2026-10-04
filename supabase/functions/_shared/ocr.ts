// Reads a photo of a handwritten shipment list (Doctor: "Мухиддин 3.10.26 / 750х — 10 / ...") with Claude.
// Needs the ANTHROPIC_API_KEY function secret.

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

export function hasOcrKey() {
  return !!Deno.env.get("ANTHROPIC_API_KEY");
}

export async function readListPhoto(base64: string, mediaType: string, knownNames: string[]): Promise<PhotoList[]> {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const known = knownNames.length
    ? `Known product codes for this supplier (use exactly these spellings when a line matches one): ${knownNames.join(", ")}.`
    : "";
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system:
      "You transcribe photos of handwritten shipment lists from a wholesale business in Uzbekistan. " +
      "A photo holds one or more lists. Each list starts with a header line: a counterparty (customer) name, " +
      "sometimes with a number, followed by a date like 3.10.26 (day.month.year). Under it are lines " +
      "'<product code> — <quantity>'. Product codes are short, e.g. 1000к, 1200сц, 1200т, 750х, 770, Б550, 2100х: " +
      "keep the digits and the Cyrillic letter suffix or prefix exactly as written, without spaces. " +
      "Return every list in the order it appears, the date as YYYY-MM-DD (null if missing), and each line's " +
      "code as name and the number after the dash as qty. Skip crossed-out lines.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: base64 } },
        { type: "text", text: `Transcribe the shipment lists in this photo. ${known}` },
      ],
    }],
  } as any);
  if ((response as any).stop_reason === "refusal") throw new Error("OCR refused");
  const text = (response.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);
  return (parsed.lists || [])
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
