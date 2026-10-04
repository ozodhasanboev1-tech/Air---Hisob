// Air hisob-kitobi Mini App. Data lives in Supabase; every call goes through the "api" edge function,
// which checks Telegram's signed initData, so the page only works when opened from the bot.
(function () {
  const $ = (id) => document.getElementById(id);
  const TG = window.Telegram && window.Telegram.WebApp;
  const API = window.AIR_CONFIG.apiUrl;

  const fmt = (n) => { const r = Math.round((n || 0) * 100) / 100; const a = Math.abs(r), i = Math.floor(a), f = Math.round((a - i) * 100); return (r < 0 ? '−' : '') + String(i).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? '.' + String(f).padStart(2, '0') : ''); };
  const parseNum = (s) => { const t = String(s ?? '').replace(/[\s ]/g, '').replace(/,/g, '.'); const v = parseFloat(t); return isFinite(v) ? v : 0; };
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
  const fmtDate = (d) => { const [y, m, dd] = d.split('-'); return +dd + ' ' + MONTHS[+m - 1].slice(0, 3) + ' ' + y; };
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

  let entries = [], priceList = {}, items = [], method = 'naqd', cur = 'USD', shipEditId = null, payEditId = null;
  const openDetail = new Set();

  // ---------- Telegram shell ----------
  if (TG) {
    TG.ready(); TG.expand();
    if (TG.colorScheme) document.documentElement.dataset.theme = TG.colorScheme;
    TG.onEvent && TG.onEvent('themeChanged', () => { document.documentElement.dataset.theme = TG.colorScheme; });
  }
  const haptic = (t) => { try { TG && TG.HapticFeedback && TG.HapticFeedback.notificationOccurred(t); } catch (e) {} };

  // ---------- API ----------
  async function api(action, body = {}) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': (TG && TG.initData) || '' },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.message || 'Xatolik'); err.status = res.status; throw err; }
    return data;
  }
  function setStore(state, txt) { $('storeDot').className = 'dot ' + state; $('storeTxt').textContent = txt; }

  async function load(quiet) {
    try {
      const d = await api('load');
      entries = d.entries || []; priceList = d.prices || {};
      const t = d.telegram || {};
      setStore('ok', 'Ulangan · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
      if (t.lastError) { $('tgDot').className = 'dot bad'; $('tgTxt').textContent = 'Bot: ' + t.lastError; }
      else { $('tgDot').className = 'dot ok'; $('tgTxt').textContent = t.lastShipmentAt ? 'Bot: oxirgi yuk ' + new Date(t.lastShipmentAt).toLocaleString('ru-RU', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Bot ishlayapti'; }
      $('gate').hidden = true;
      render(); if (!quiet) drawPrices();
    } catch (err) {
      setStore('bad', 'Ulanib bo\'lmadi');
      if (err.status === 401 || err.status === 403) {
        $('gate').hidden = false;
        $('gate').textContent = err.status === 401 ? 'Bu ilova faqat Telegramdagi @Air_Hisobi_bot ichidan ochiladi.' : err.message;
        $('ledgerRows').innerHTML = '';
      }
    }
  }
  async function saveEntry(id, data) { await api('save', { entry: Object.assign({ id }, data) }); await load(true); }
  async function removeEntry(id) { await api('delete', { id }); await load(true); }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    window.scrollTo({ top: 0 });
  }
  document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  // ---------- prices ----------
  function lastPrices() {
    const map = {};
    [...entries].filter((e) => e.kind === 'shipment').sort(byDate).forEach((e) => (e.items || []).forEach((it) => { if (it.price > 0) map[norm(it.name)] = it.price; }));
    Object.keys(priceList).forEach((k) => { if (priceList[k] > 0) map[norm(k)] = priceList[k]; });
    return map;
  }
  let priceDraft = [];
  function drawPrices() {
    priceDraft = Object.keys(priceList).sort().map((k) => ({ name: k, price: priceList[k] }));
    paintPrices();
  }
  function paintPrices() {
    $('priceRows').innerHTML = priceDraft.length ? priceDraft.map((p, i) => `<tr>
      <td><input data-pi="${i}" data-f="name" value="${esc(p.name)}" aria-label="Tovar nomi"></td>
      <td class="r"><input class="n num" data-pi="${i}" data-f="price" inputmode="decimal" value="${p.price || ''}" aria-label="Narx"></td>
      <td><button type="button" class="ghost danger" data-pdel="${i}" aria-label="O'chirish">×</button></td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">Narx kiritilmagan</td></tr>';
  }
  $('priceRows').addEventListener('input', (e) => { const i = e.target.dataset.pi; if (i == null) return; priceDraft[i][e.target.dataset.f] = e.target.dataset.f === 'name' ? e.target.value : parseNum(e.target.value); });
  $('priceRows').addEventListener('click', (e) => { const d = e.target.dataset.pdel; if (d != null) { priceDraft.splice(+d, 1); paintPrices(); } });
  $('addPrice').onclick = () => { priceDraft.push({ name: '', price: 0 }); paintPrices(); };
  $('savePrices').onclick = async () => {
    const out = {}; priceDraft.forEach((p) => { if (norm(p.name) && p.price > 0) out[norm(p.name)] = p.price; });
    try { const r = await api('prices', { items: out }); priceList = r.items; drawPrices(); msg('priceMsg', 'Saqlandi'); haptic('success'); }
    catch (err) { msg('priceMsg', err.message, true); haptic('error'); }
  };

  // ---------- parsing Бобур's list ----------
  const UNIT = '(?:ta|dona|шт\\.?|штук[аи]?|та|дона|кор\\.?|коробка|karobka|blok|блок|pcs|k|к|x?)';
  function parseList(text) {
    const prices = lastPrices();
    const out = [], dest = [];
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.replace(/^[\s\-–—•*·▪️✅➖🔹🔸]+/u, '').replace(/^\d{1,3}[.)]\s+/, '').trim();
      if (!line) return;
      let name = line, qty = 0, price = 0, m;
      m = line.match(new RegExp('^(.*?)[\\s:=\\-–—]+(\\d[\\d\\s.,]*)\\s*' + UNIT + '\\s*[x×*хХ]\\s*(\\d[\\d\\s.,]*)\\s*\\$?\\.?\\s*$', 'iu'));
      if (m) { name = m[1]; qty = parseNum(m[2]); price = parseNum(m[3]); }
      else {
        m = line.match(new RegExp('^(.*?)[\\s:=\\-–—]+(\\d[\\d\\s.,]*)\\s*' + UNIT + '\\.?\\s*$', 'iu'));
        if (m && m[1].trim()) { name = m[1]; qty = parseNum(m[2]); }
        else { m = line.match(new RegExp('^(\\d[\\d.,]*)\\s*' + UNIT + '\\s+(.+)$', 'iu')); if (m) { qty = parseNum(m[1]); name = m[2]; } }
      }
      name = name.replace(/[\s:=\-–—]+$/, '').trim();
      if (!name) return;
      if (!qty) { dest.push(name); return; }
      if (!price) price = prices[norm(name)] || 0;
      out.push({ name, qty, price });
    });
    out.dest = dest.join(', ');
    return out;
  }

  // ---------- shipment form ----------
  function drawItems() {
    const tb = $('itemRows');
    if (!items.length) tb.innerHTML = '<tr><td colspan="5" class="empty">Ro\'yxatni joylab «Ro\'yxatni ajratish»ni bosing yoki qatorni qo\'lda qo\'shing.</td></tr>';
    else tb.innerHTML = items.map((it, i) => `<tr>
      <td><input id="in${i}" data-i="${i}" data-f="name" value="${esc(it.name)}" aria-label="Tovar nomi"></td>
      <td class="r"><input class="n num" data-i="${i}" data-f="qty" inputmode="decimal" value="${it.qty || ''}" aria-label="Karobka soni"></td>
      <td class="r"><input class="n num" data-i="${i}" data-f="price" inputmode="decimal" value="${it.price || ''}" placeholder="narx" aria-label="Narxi"></td>
      <td class="r num" id="is${i}">${fmt(it.qty * it.price)}</td>
      <td><button type="button" class="ghost danger" data-del="${i}" aria-label="Qatorni o'chirish">×</button></td></tr>`).join('');
    updShipTotal();
  }
  function updShipTotal() {
    let t = 0; items.forEach((it, i) => { const s = it.qty * it.price; t += s; const c = $('is' + i); if (c) c.textContent = fmt(s); });
    $('shipTotal').textContent = fmt(t);
  }
  $('itemRows').addEventListener('input', (e) => { const i = e.target.dataset.i, f = e.target.dataset.f; if (i == null) return; items[i][f] = f === 'name' ? e.target.value : parseNum(e.target.value); updShipTotal(); });
  $('itemRows').addEventListener('click', (e) => { const d = e.target.dataset.del; if (d != null) { items.splice(+d, 1); drawItems(); } });
  $('addRow').onclick = () => { items.push({ name: '', qty: 0, price: 0 }); drawItems(); const el = $('in' + (items.length - 1)); el && el.focus(); };
  $('parseBtn').onclick = () => {
    const parsed = parseList($('shipPaste').value);
    if (!parsed.length) { msg('shipMsg', 'Ro\'yxatdan tovar topilmadi. Qatorlarni «nomi – soni» ko\'rinishida yozing.', true); return; }
    items = items.filter((it) => it.name.trim()).concat(parsed);
    if (parsed.dest && !$('shipNote').value.trim()) $('shipNote').value = parsed.dest;
    const noPrice = parsed.filter((p) => !p.price).length;
    drawItems();
    msg('shipMsg', parsed.length + ' ta tovar ajratildi' + (noPrice ? ', ' + noPrice + ' tasiga narx yozing' : ''));
  };
  function resetShip() { items = []; shipEditId = null; $('shipDate').value = today(); $('shipNote').value = ''; $('shipPaste').value = ''; $('shipEditing').hidden = true; drawItems(); }
  $('shipCancel').onclick = () => { resetShip(); msg('shipMsg', ''); showTab('ledger'); };
  $('shipForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const clean = items.filter((it) => it.name.trim() && it.qty > 0).map((it) => ({ name: it.name.trim(), qty: it.qty, price: it.price || 0 }));
    if (!clean.length) { msg('shipMsg', 'Kamida bitta tovar va uning sonini kiriting.', true); return; }
    const total = clean.reduce((s, it) => s + it.qty * it.price, 0);
    const prev = shipEditId && entries.find((x) => x.id === shipEditId);
    const data = { kind: 'shipment', date: $('shipDate').value || today(), note: $('shipNote').value.trim(), items: clean, createdAt: prev ? prev.createdAt : Date.now(), source: prev ? prev.source : 'app', sender: prev ? prev.sender : null };
    const btn = e.submitter; if (btn) btn.disabled = true;
    try { await saveEntry(shipEditId, data); resetShip(); msg('shipMsg', 'Saqlandi: ' + fmt(total) + ' $'); haptic('success'); showTab('ledger'); }
    catch (err) { msg('shipMsg', err.message, true); haptic('error'); }
    finally { if (btn) btn.disabled = false; }
  });

  // ---------- payment form ----------
  function setMethod(m) { method = m; $('mCash').setAttribute('aria-pressed', m === 'naqd'); $('mBank').setAttribute('aria-pressed', m === 'perechisleniya'); }
  function setCur(c) { cur = c; $('cUsd').setAttribute('aria-pressed', c === 'USD'); $('cUzs').setAttribute('aria-pressed', c === 'UZS'); $('rateWrap').hidden = c !== 'UZS'; $('payAmount').placeholder = c === 'UZS' ? '5 000 000' : '1 000'; updConv(); }
  function updConv() { const a = parseNum($('payAmount').value), r = parseNum($('payRate').value); $('payConv').textContent = cur === 'UZS' && a && r ? '= ' + fmt(a / r) + ' $' : ''; }
  $('cUsd').onclick = () => setCur('USD');
  $('cUzs').onclick = () => setCur('UZS');
  $('payAmount').addEventListener('input', updConv); $('payRate').addEventListener('input', updConv);
  $('mCash').onclick = () => setMethod('naqd');
  $('mBank').onclick = () => setMethod('perechisleniya');
  function resetPay() { payEditId = null; $('payDate').value = today(); $('payAmount').value = ''; $('payRate').value = ''; $('payNote').value = ''; $('payEditing').hidden = true; setMethod('naqd'); setCur('USD'); }
  $('payCancel').onclick = () => { resetPay(); msg('payMsg', ''); showTab('ledger'); };
  $('payForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = parseNum($('payAmount').value), rate = parseNum($('payRate').value);
    if (!(raw > 0)) { msg('payMsg', 'Summani kiriting.', true); return; }
    if (cur === 'UZS' && !(rate > 0)) { msg('payMsg', 'So\'mdagi to\'lov uchun kursni kiriting.', true); return; }
    const amount = cur === 'UZS' ? Math.round(raw / rate * 100) / 100 : raw;
    const prev = payEditId && entries.find((x) => x.id === payEditId);
    const data = { kind: 'payment', method, date: $('payDate').value || today(), amount, note: $('payNote').value.trim(), createdAt: prev ? prev.createdAt : Date.now(), source: prev ? prev.source : 'app', sender: prev ? prev.sender : null };
    if (cur === 'UZS') { data.sumUzs = raw; data.rate = rate; }
    const btn = e.submitter; if (btn) btn.disabled = true;
    try { await saveEntry(payEditId, data); resetPay(); msg('payMsg', 'Saqlandi: ' + fmt(amount) + ' $'); haptic('success'); showTab('ledger'); }
    catch (err) { msg('payMsg', err.message, true); haptic('error'); }
    finally { if (btn) btn.disabled = false; }
  });

  const timers = {};
  function msg(id, t, isErr) { const el = $(id); el.textContent = t; el.className = 'msg' + (isErr ? ' err' : ''); clearTimeout(timers[id]); if (t && !isErr) timers[id] = setTimeout(() => { el.textContent = ''; }, 6000); }

  // ---------- ledger ----------
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0));
  const amountOf = (e) => (e.kind === 'shipment' ? (e.total || 0) : (e.amount || 0));

  function render() {
    const sorted = [...entries].sort(byDate);
    let bal = 0, ship = 0, cash = 0, bank = 0, nS = 0, nC = 0, nB = 0;
    const balAfter = {};
    sorted.forEach((e) => {
      if (e.kind === 'shipment') { bal += e.total || 0; ship += e.total || 0; nS++; }
      else { bal -= e.amount || 0; if (e.method === 'perechisleniya') { bank += e.amount || 0; nB++; } else { cash += e.amount || 0; nC++; } }
      balAfter[e.id] = bal;
    });
    $('totShip').textContent = fmt(ship); $('totCash').textContent = fmt(cash); $('totBank').textContent = fmt(bank);
    $('cntShip').textContent = nS + ' ta ro\'yxat'; $('cntCash').textContent = nC + ' marta'; $('cntBank').textContent = nB + ' marta';
    const v = $('balVal');
    if (bal > 0.004) { $('balLabel').textContent = 'Air\'ga qarzimiz'; v.className = 'v num debt'; v.textContent = fmt(bal) + ' $'; $('balHint').textContent = 'Yuklar ' + fmt(ship) + ' − to\'lovlar ' + fmt(cash + bank); }
    else if (bal < -0.004) { $('balLabel').textContent = 'Ortiqcha to\'langan'; v.className = 'v num over'; v.textContent = fmt(-bal) + ' $'; $('balHint').textContent = 'Air keyingi yuklarda hisobga oladi'; }
    else { $('balLabel').textContent = 'Qarz yo\'q'; v.className = 'v num'; v.textContent = '0 $'; $('balHint').textContent = entries.length ? 'Hisob teng' : 'Birinchi yuk yoki to\'lovni qo\'shing'; }
    const base = Math.max(ship, cash + bank, 1);
    $('barCash').style.width = (cash / base * 100) + '%'; $('barBank').style.width = (bank / base * 100) + '%';

    const sel = $('monthSel'), was = sel.value;
    const months = [...new Set(sorted.map((e) => e.date.slice(0, 7)))].sort().reverse();
    sel.innerHTML = '<option value="">Hamma oylar</option>' + months.map((m) => `<option value="${m}">${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}</option>`).join('');
    sel.value = months.includes(was) ? was : '';
    const mf = sel.value;
    const shown = sorted.filter((e) => !mf || e.date.startsWith(mf)).reverse();
    let pS = 0, pP = 0; shown.forEach((e) => { if (e.kind === 'shipment') pS += e.total || 0; else pP += e.amount || 0; });
    $('periodTxt').textContent = mf ? 'Yuk ' + fmt(pS) + ' · to\'lov ' + fmt(pP) : '';

    const box = $('ledgerRows');
    if (!shown.length) {
      box.innerHTML = '<div class="empty"><b>Hali yozuv yo\'q</b>Бобур guruhga ro\'yxat tashlasa, bot o\'zi qo\'shadi. To\'lovni botga «naqd 500$» deb yozing yoki «+ To\'lov»dan kiriting.</div>';
    } else {
      box.innerHTML = shown.map((e) => {
        const isS = e.kind === 'shipment';
        const tag = isS ? '<span class="tag ship">YUK</span>' : (e.method === 'perechisleniya' ? '<span class="tag bank">PERECH.</span>' : '<span class="tag cash">NAQD</span>');
        const its = e.items || [];
        const noPrice = its.filter((i) => !i.price).length;
        const src = e.source === 'telegram' ? ' · Telegram' : '';
        const desc = isS
          ? esc(its.slice(0, 2).map((i) => i.name + ' ' + fmt(i.qty) + ' k').join(', ')) + (its.length > 2 ? ' va yana ' + (its.length - 2) + ' ta' : '') + `<small>${e.note ? esc(e.note) : 'manzil yo\'q'}${src}${noPrice ? ' · <span style="color:var(--debt)">' + noPrice + ' tasi narxsiz</span>' : ''}</small>`
          : esc(e.note || 'To\'lov') + '<small>' + [e.sumUzs ? fmt(e.sumUzs) + ' so\'m, kurs ' + fmt(e.rate) : '', e.source === 'telegram' ? 'Telegram' : ''].filter(Boolean).join(' · ') + '</small>';
        const open = openDetail.has(e.id);
        return `<div class="card">
          <div class="top"><span class="when num">${tag}${fmtDate(e.date)}</span><span class="amt num ${isS ? 'plus' : 'minus'}">${isS ? '+' : '−'}${fmt(amountOf(e))} $</span></div>
          <div class="desc">${desc}</div>
          ${isS && open ? `<ul>${its.map((i) => `<li>${esc(i.name)} — <span class="num">${fmt(i.qty)} × ${i.price ? fmt(i.price) : '?'} = ${fmt(i.qty * i.price)} $</span></li>`).join('')}</ul>` : ''}
          <div class="top"><span class="bal num">Qoldiq: ${fmt(balAfter[e.id])} $</span><span class="acts">${isS ? `<button class="ghost" data-act="open" data-id="${esc(e.id)}" aria-expanded="${open}">${open ? 'Yopish' : 'Ro\'yxat'}</button>` : ''}<button class="ghost" data-act="edit" data-id="${esc(e.id)}">Tahrirlash</button><button class="ghost danger" data-act="del" data-id="${esc(e.id)}">O'chirish</button></span></div>
        </div>`;
      }).join('');
    }

    const prod = {};
    sorted.filter((e) => e.kind === 'shipment' && (!mf || e.date.startsWith(mf))).forEach((e) => (e.items || []).forEach((i) => {
      const k = norm(i.name); const p = prod[k] || (prod[k] = { name: i.name, qty: 0, sum: 0, price: 0 });
      p.qty += i.qty; p.sum += i.qty * i.price; if (i.price) p.price = i.price;
    }));
    const pl = Object.values(prod).sort((a, b) => b.sum - a.sum || b.qty - a.qty);
    $('prodRows').innerHTML = pl.length ? pl.map((p) => `<tr><td>${esc(p.name)}</td><td class="r num">${fmt(p.qty)}</td><td class="r num">${p.price ? fmt(p.price) : '—'}</td><td class="r num">${fmt(p.sum)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Yuk qo\'shilgach, har bir tovar bo\'yicha jami shu yerda chiqadi.</td></tr>';
  }
  $('monthSel').onchange = render;

  const pendingDel = {};
  $('ledgerRows').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const id = b.dataset.id, e = entries.find((x) => x.id === id); if (!e) return;
    if (b.dataset.act === 'open') { openDetail.has(id) ? openDetail.delete(id) : openDetail.add(id); render(); }
    else if (b.dataset.act === 'edit') {
      if (e.kind === 'shipment') {
        shipEditId = id; items = (e.items || []).map((i) => Object.assign({}, i)); $('shipDate').value = e.date; $('shipNote').value = e.note || ''; $('shipPaste').value = '';
        $('shipEditing').hidden = false; drawItems(); showTab('ship');
      } else {
        payEditId = id; setMethod(e.method === 'perechisleniya' ? 'perechisleniya' : 'naqd'); $('payDate').value = e.date;
        if (e.sumUzs && e.rate) { setCur('UZS'); $('payAmount').value = fmt(e.sumUzs); $('payRate').value = fmt(e.rate); } else { setCur('USD'); $('payAmount').value = fmt(e.amount); }
        updConv(); $('payNote').value = e.note || ''; $('payEditing').hidden = false; showTab('pay');
      }
    } else if (b.dataset.act === 'del') {
      if (!pendingDel[id]) { pendingDel[id] = setTimeout(() => { delete pendingDel[id]; if (b.isConnected) b.textContent = 'O\'chirish'; }, 4000); b.textContent = 'Rostdan o\'chirilsinmi?'; return; }
      clearTimeout(pendingDel[id]); delete pendingDel[id];
      try { b.disabled = true; await removeEntry(id); haptic('success'); } catch (err) { b.disabled = false; b.textContent = 'O\'chmadi'; }
    }
  });

  resetShip(); resetPay(); render(); load();
  // Refresh when the app comes back to the foreground and every 30 s, so the bot's new posts show up.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
  setInterval(() => { if (!document.hidden) load(true); }, 30000);
})();
