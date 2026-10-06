#!/usr/bin/env python3
"""Helper for Claude reading shipment photos by hand (the bot no longer runs Gemini).

  python3 scripts/photos.py list DIR
      Downloads every unread photo («📷 o'qilmagan rasm») into DIR and prints, per photo, the
      entry id, firm, sender, date, local path, and that firm's price keys.
  python3 scripts/photos.py save ENTRY_ID FILE.json
      FILE.json is a list of shipments read from that photo:
        [{"counterparty": "Наманган", "date": "2026-10-06", "items": [{"name": "400 х", "qty": 40}]}]
      Item names must be the firm's price keys. Prices come from firms.prices, totals get the
      firm discount, the first list replaces ENTRY_ID and further ones go to <base>-2, -3, …
      Then the owner gets a Telegram note from the bot.

Needs SUPABASE_URL, SUPABASE_SERVICE_KEY and TELEGRAM_BOT_TOKEN in the environment.
"""
import json, os, sys, urllib.parse, urllib.request

URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
UNREAD = "📷 o'qilmagan rasm"
OWNER_IDS = [int(x) for x in os.environ.get("OWNER_IDS", "6158024788").split(",")]


def call(path, method="GET", body=None, raw=False):
    req = urllib.request.Request(f"{URL}{path}", method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("apikey", KEY)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation,resolution=merge-duplicates")
    with urllib.request.urlopen(req) as r:
        data = r.read()
    return data if raw else json.loads(data or b"null")


def firms():
    return {f["id"]: f for f in call("/rest/v1/firms?select=*")}


def tg(text):
    tok = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not tok:
        return
    for chat in OWNER_IDS:
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/sendMessage", data=data).read()


def fmt(n):
    return f"{n:,.2f}".replace(",", " ").rstrip("0").rstrip(".")


def cmd_list(out):
    os.makedirs(out, exist_ok=True)
    rows = call("/rest/v1/entries?kind=eq.shipment&note=eq." + urllib.parse.quote(UNREAD) + "&select=*&order=created_at.asc")
    fs = firms()
    result = []
    for r in rows:
        o = r.get("original") or {}
        if not o.get("photo") or o.get("deletedAt") or r.get("items"):
            continue
        path = os.path.join(out, o["photo"].replace("/", "_"))
        with open(path, "wb") as f:
            f.write(call("/storage/v1/object/originals/" + o["photo"], raw=True))
        f = fs.get(r["firm"], {})
        result.append({"id": r["id"], "firm": r["firm"], "sender": r.get("sender"), "date": r["date"],
                       "caption": o.get("text"), "file": path, "discount_pct": f.get("discount_pct"),
                       "price_keys": sorted((f.get("prices") or {}).keys())})
    print(json.dumps(result, ensure_ascii=False, indent=1))


def cmd_save(entry_id, file):
    lists = json.load(open(file))
    [row] = call(f"/rest/v1/entries?id=eq.{urllib.parse.quote(entry_id)}&select=*")
    firm = firms()[row["firm"]]
    prices, disc = firm.get("prices") or {}, float(firm.get("discount_pct") or 0)
    original = {k: v for k, v in (row.get("original") or {}).items() if k != "ocrTries"}
    original["readBy"] = "claude"
    base = entry_id.rsplit("-", 1)[0]
    lines, total_sum, missing = [], 0.0, []
    for i, l in enumerate(lists):
        items = []
        for it in l["items"]:
            price = prices.get(it["name"], 0)
            if not price:
                missing.append(it["name"])
            items.append({"qty": it["qty"], "name": it["name"], "price": price})
        gross = round(sum(it["qty"] * it["price"] for it in items), 2)
        total = round(gross * (1 - disc / 100), 2)
        body = {"id": f"{base}-{i + 1}", "firm": row["firm"], "kind": "shipment", "date": l.get("date") or row["date"],
                "note": l.get("counterparty") or "", "items": items, "total": total, "gross": gross,
                "discount_pct": disc, "source": "telegram", "sender": row.get("sender"),
                "created_at": (row.get("created_at") or 0) + i, "original": original}
        call("/rest/v1/entries?on_conflict=id", "POST", body)
        total_sum += total
        qty = sum(it["qty"] for it in items)
        lines.append(f"• {body['note'] or '?'}: {len(items)} xil, {fmt(qty)} k → {fmt(total)} $")
    when = f"{row['date'][8:10]}.{row['date'][5:7]}"
    head = f"📷 «{firm['name']}»: {row.get('sender') or ''} {when} dagi rasmni Claude o'qidi" + (f", −{fmt(disc)}% bilan" if disc else "")
    note = f"\n⚠️ Narxi yo'q: {', '.join(sorted(set(missing)))}" if missing else ""
    tg(f"{head}:\n" + "\n".join(lines) + f"\nJami: {fmt(total_sum)} ${note}\n\nXato bo'lsa ilovada «Tahrirlash» bilan tuzating.")
    print(json.dumps({"saved": len(lists), "total": round(total_sum, 2), "missing_prices": sorted(set(missing))}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "list":
        cmd_list(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "save":
        cmd_save(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
