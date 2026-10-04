# Air hisob-kitobi

Бобур chiqargan Air yuklari va bizning to'lovlar (naqd / perechisleniya) hisobi, dollarda.
Telegram ichida @Air_Hisobi_bot orqali ochiladigan Mini App.

## Qanday ishlaydi

- **Bot (`supabase/functions/telegram`)** — Telegram webhook. «Айр хисоб китоб» guruhidagi Бобур ro'yxatlarini
  yuk sifatida yozadi; Ozodbekdan to'lov («naqd 500$», «perech 5 000 000 so'm kurs 12650»),
  bekor qilish («otkaz perech 04.10») va «qoldiq» buyruqlarini qabul qiladi.
- **API (`supabase/functions/api`)** — Mini App uchun backend. Telegram `initData` imzosini tekshiradi,
  faqat `OWNER_IDS` dagi foydalanuvchilarga ruxsat beradi.
- **Mini App (`docs/`)** — GitHub Pages'da joylashgan sahifa: balans, harakatlar, yuk/to'lov qo'shish va
  tahrirlash, tovar narxlari.
- **Ma'lumotlar** — Supabase Postgres: `entries` (yuk va to'lovlar) va `meta` (`prices`, `telegram`).
  Jadval sxemasi: `supabase/migrations/001_init.sql`.

## O'zgartirish

- Sahifa: `docs/` dagi fayllarni o'zgartirib `main` ga push qiling — GitHub Pages o'zi yangilanadi.
- Bot yoki API: `supabase/functions/` ni o'zgartirib `SUPABASE_ACCESS_TOKEN=... scripts/deploy-functions.sh`.
- Funksiya sozlamalari (Supabase → Edge Functions → Secrets): `TELEGRAM_BOT_TOKEN`, `TG_WEBHOOK_SECRET`,
  `OWNER_IDS` (vergul bilan Telegram id'lar), `APP_URL`.
