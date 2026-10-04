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
- **Firmalar** — har bir yetkazib beruvchi (Air, Timson, ...) o'z Telegram guruhiga ega. Guruhda egasi
  «/firma Nomi» deb yozsa, guruh shu firmaga bog'lanadi; yuk tashlovchining xabariga javoban «/yuk» yozilsa,
  o'sha odamning ro'yxatlari yuk sifatida yoziladi. Botga yozilgan to'lovda bot firmani tugma bilan so'raydi.
- **Rasmdan o'qish** — yuk tashlovchi qo'lda yozilgan ro'yxat rasmini tashlasa (Doctor), bot uni Claude bilan
  o'qiydi (`supabase/functions/_shared/ocr.ts`, `ANTHROPIC_API_KEY` secret kerak) va har bir mijoz ro'yxatini
  alohida yuk qilib yozadi. Ilovada ham «📷 Rasmdan o'qish» tugmasi bor.
- **Chegirma** — har bir firmaga foiz (Doctor 13%); yuk summasidan ayirib yoziladi, ilovada «Tovarlar»da o'zgartiriladi.
- **Ma'lumotlar** — Supabase Postgres: `firms` (nom, guruh, yuk tashlovchilar, narxlar), `entries`
  (yuk va to'lovlar, `firm` ustuni bilan) va `meta` (`telegram`). Sxema: `supabase/migrations/`.

## O'zgartirish

- Sahifa: `docs/` dagi fayllarni o'zgartirib `main` ga push qiling — GitHub Pages o'zi yangilanadi.
- Bot yoki API: `supabase/functions/` ni o'zgartirib `SUPABASE_ACCESS_TOKEN=... scripts/deploy-functions.sh`.
- Funksiya sozlamalari (Supabase → Edge Functions → Secrets): `TELEGRAM_BOT_TOKEN`, `TG_WEBHOOK_SECRET`,
  `OWNER_IDS` (vergul bilan Telegram id'lar), `APP_URL`.
