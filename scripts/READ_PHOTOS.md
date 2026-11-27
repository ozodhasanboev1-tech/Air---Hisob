# Reading shipment photos (Claude, scheduled)

The bot no longer reads photos with Gemini. Each list photo from a poster is stored and left as an
empty shipment with note «📷 o'qilmagan rasm». A scheduled Claude session reads them:

1. `python3 scripts/photos.py list <scratch dir>` — downloads the unread photos and prints, per photo,
   its entry id, firm, sender, date, file path and the firm's price keys. Empty list → stop.
2. Open each photo with the Read tool and transcribe every list on it: the header (client / city
   and date, e.g. «Наманган 6.10.26») and every line «<product> — <qty>».
3. Map each product to one of that firm's price keys exactly as written in `price_keys`
   (Doctor examples: «400х» → `400 х`, «б550х» → `б 550 х`, «б1000» → `б 1000`, «ф-б300» → `ф-б 300`,
   «1100» → `1100`). A suffix with no own key keeps its written name (e.g. `б 550 м`); the script
   flags it as unpriced.
4. Write the lists to a JSON file and run `python3 scripts/photos.py save <entry id> <file>`.
   It prices the items, applies the firm discount, saves the rows and sends the owner a Telegram note.
5. If a photo cannot be read at all (not a list, unreadable), leave it as is and mention it in the
   final note to the owner.

Never touch a shipment that already has items. Never print secret values.

## Money transfers (perechisleniya) on photos

Timson (Китай) photos can be bank-transfer notes, not lists: «date / client N…/R / so'm sum / rate».
Save each line as its own `kind: payment`, `method: perechisleniya`, `sum_uzs`, `rate`,
`amount = sum_uzs / rate` (2 decimals), note = client and contract.

- Handwritten zeros run together. Never count the circles: read the leading digits and check the
  dollar result. A single transfer is usually a few thousand dollars (65 mln / 12020 = 5 407 $).
  If `amount` comes out above 15 000 $, assume a 10x misread, recount, and list it to the owner as
  doubtful. (27.11.2026: 65 mln was saved as 650 mln.)
- Timson has an opening row `opening-timson` dated 11.11.2026, but that sverka date was assumed.
  Save transfers dated before it too (owner confirmed 27.11), and mention them to the owner.
- A crossed-out number is replaced by the one under it.
