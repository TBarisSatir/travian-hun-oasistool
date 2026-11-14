// Arayüz. Savaş hesabı içermez: her sonuç battle.js / optimizer.js üzerinden üretilir.
import { HUN_UNITS, ALL_HUN_IDS, OPT_UNIT_IDS, HUN_WEAPONS } from '../data/units.js';
import { ANIMALS, ANIMAL_IDS, OASIS_TYPES, OASIS_TYPE_IDS } from '../data/nature.js';
import { REFERENCE_CASES, checkReference, battleKey } from '../data/references.js';
import { createScenario } from '../engine/battle.js';
import { distance, tripHours, formatHours, estimateOasisStock } from '../engine/travel.js';
import { compareHeroModes } from '../optimizer/optimizer.js';
import { parseAnimalText, parseCoords } from '../vision/parse.js';
import { recognizeWithClaude, VISION_MODELS } from '../vision/claude.js';
import { recognizeWithOcr } from '../vision/ocr.js';
import { loadState, saveState, importState, DEFAULT_STATE } from './store.js';

let S = loadState();
const T = { tab: 'oasis', result: null, simReport: null, busy: false, progress: 0, image: null, visionMsg: null, visionBusy: false, lastReport: null, heroImage: null, toast: null };
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const fmt = (n) => (n == null || !isFinite(n) ? '—' : nf.format(Math.round(n)));
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const pct = (n, d = 1) => (n == null || !isFinite(n) ? '—' : '%' + n.toFixed(d).replace('.', ','));
const num = (v, def = 0) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : def; };
const int = (v) => Math.max(0, Math.floor(num(v)));
const getPath = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), S);
function setPath(p, v) { const ks = p.split('.'); const last = ks.pop(); const o = ks.reduce((x, k) => (x[k] ??= {}), S); o[last] = v; }
const persist = () => { if (!saveState(S)) toast('Kayıt başarısız (depolama dolu olabilir).'); };
function toast(msg) { T.toast = msg; renderToast(); clearTimeout(toast.t); toast.t = setTimeout(() => { T.toast = null; renderToast(); }, 3500); }
function renderToast() { const el = $('#toast'); el.textContent = T.toast || ''; el.hidden = !T.toast; }

// ---------- Senaryo kurulumu (Simülatör ve Optimizasyon aynı fonksiyonu kullanır) ----------
const coordsOk = (c) => c && c.x !== '' && c.y !== '' && isFinite(+c.x) && isFinite(+c.y);
function travelCfg() {
  if (!coordsOk(S.profile.village) || !coordsOk(S.oasis.coords)) return null;
  const d = distance({ x: +S.profile.village.x, y: +S.profile.village.y }, { x: +S.oasis.coords.x, y: +S.oasis.coords.y });
  return d > 0 ? { distance: d, speedFactor: num(S.profile.unitSpeedFactor, 1) || 1, tsLevel: int(S.profile.tsLevel) } : null;
}
function heroCfg() {
  const h = S.profile.hero;
  return { strength: num(h.strength), offBonusPct: num(h.offBonusPct), health: num(h.health, 100), mounted: !!h.mounted, speed: num(h.speed, 14), weaponId: h.weaponId, armorReduction: num(h.armorReduction) };
}
function baseConfig(unitIds, mode) {
  return {
    unitIds, smithy: S.profile.smithy, hero: null, mode,
    animals: Object.fromEntries(ANIMAL_IDS.map((id) => [id, int(S.oasis.animals[id])]).filter(([, v]) => v > 0)),
    otherAttackBonusPct: num(S.profile.otherAttackBonusPct),
    loot: { available: S.oasis.stock.map((v) => int(v)), lootablePct: num(S.oasis.lootablePct, 100) },
    weights: S.prefs.weights.map((w) => num(w, 1)), travel: travelCfg(), extraCost: num(S.prefs.extraCost),
  };
}
function prefsCfg() {
  return { maxLossRatio: S.prefs.lossFilterOn ? num(S.prefs.maxLossRatio, 50) : null, requireProfit: !!S.prefs.requireProfit, profitThresholdPct: Math.min(100, Math.max(50, num(S.prefs.profitThresholdPct, 90))), minHeroHealth: num(S.prefs.minHeroHealth, 30) };
}

// ---------- Güvenilirlik durumu ----------
function statusOf(rep) {
  const refs = [...REFERENCE_CASES, ...S.refs];
  const plain = !rep.hero && !rep.uncertain.smithy && !num(S.profile.otherAttackBonusPct);
  if (plain) {
    const key = battleKey(rep.mode, Object.fromEntries(rep.units.map((u) => [u.id, u.sent])), Object.fromEntries(rep.animals.map((a) => [a.id, a.count])));
    const ref = refs.find((r) => battleKey(r.mode, r.units, r.animals) === key);
    if (ref && checkReference(ref).ok) return { cls: 'ok', label: 'Doğrulanmış', text: 'Aynı parametrelerle oyun kaynağıyla birebir eşleşiyor: ' + ref.name };
  }
  const why = [];
  if (rep.borderAtt) why.push('bir asker türünün kaybı 0,5 yuvarlama sınırına çok yakın');
  if (rep.borderDef) why.push('bir hayvan türünün kaybı yuvarlama sınırına çok yakın');
  if (rep.hero) why.push('kahraman can kaybı doğrulanmamış bir model tahminidir');
  if (rep.uncertain.smithy) why.push('demirci formülünün yuvarlaması belgelenmemiş');
  if (rep.uncertain.largeBattle) why.push('büyük savaş üssü (K) kullanıldı');
  if (rep.borderline || rep.hero) return { cls: 'warn', label: 'Dikkat / sınırda', text: 'Küçük farklar sonucu değiştirebilir: ' + why.join('; ') + '.' };
  return { cls: 'est', label: 'Matematiksel tahmin', text: 'Kaynaklardaki formüllerle hesaplandı; bu savaş oyunla birebir karşılaştırılmadı.' + (why.length ? ' Not: ' + why.join('; ') + '.' : '') };
}

// ---------- Sonuç kartı ----------
function armyLine(rep) {
  const parts = OPT_UNIT_IDS.concat(ALL_HUN_IDS.filter((i) => !OPT_UNIT_IDS.includes(i))).map((id) => rep.units.find((u) => u.id === id)).filter(Boolean).map((u) => `<b>${u.sent}</b> ${esc(u.tr)}`);
  if (rep.hero) parts.push('<b>Kahraman</b>');
  return parts.join(' + ') || '—';
}
function sentence(rep) {
  const lostTxt = rep.units.filter((u) => u.lost > 0).map((u) => `${u.lost} ${u.tr}`).join(', ') || 'yok';
  const u = (id) => (rep.units.find((x) => x.id === id) || { sent: 0 }).sent;
  let s = `<b>${u('steppeRider')}</b> Bozkır Atlısı, <b>${u('marksman')}</b> Nişancı, <b>${u('marauder')}</b> Yağmacı gönder. Kahramanı <b>${rep.hero ? 'dahil et' : 'dahil etme'}</b>. `;
  s += `Beklenen asker kaybı: <b>${esc(lostTxt)}</b>`;
  if (rep.hero) s += `, kahraman can kaybı: <b>${pct(rep.heroDamage)}</b> (tahmin)`;
  s += `. Toplam net kâr: <b>${signed(rep.net)}</b>, ekonomik kayıp oranı: <b>${rep.lossRatio == null ? 'uygulanamaz' : pct(rep.lossRatio, 2)}</b>.`;
  return s;
}
const row = (k, v, cls = '') => `<div class="kv ${cls}"><span>${k}</span><b>${v}</b></div>`;
function explain(rep) {
  const x = rep.attLoss / (1 - rep.attLoss || 1);
  const lines = [
    `Saldırı = ${rep.units.map((u) => `${u.sent}×${+u.attackEach.toFixed(2)}`).join(' + ') || '0'}${rep.hero ? ` + kahraman ${fmt(rep.hero.strength)}` : ''}${rep.hero && rep.hero.offBonusPct ? ` (×${1 + rep.hero.offBonusPct / 100})` : ''} = <b>${fmt(rep.off)}</b>`,
    `Savunma = ${rep.animals.map((a) => `${a.count} ${a.tr}`).join(' + ') || 'hayvan yok'} (saldırının piyade/süvari payına göre) + ${rep.rules.baseDefense} taban = <b>${fmt(rep.def)}</b>`,
    rep.mode === 'raid'
      ? `Yağma: x = (${fmt(Math.min(rep.def, rep.off))}/${fmt(Math.max(rep.def, rep.off))})^${rep.K.toFixed(4)}; saldırgan kaybı = ${rep.off >= rep.def ? 'x/(1+x)' : '1/(1+x)'} = <b>${pct(rep.attLoss * 100, 3)}</b>, hayvan kaybı = <b>${pct(rep.defLoss * 100, 3)}</b>`
      : `Normal saldırı (K=${rep.K.toFixed(4)}): saldırgan kaybı <b>${pct(rep.attLoss * 100, 3)}</b>, hayvan kaybı <b>${pct(rep.defLoss * 100, 3)}</b>`,
    ...rep.units.map((u) => `${u.tr}: ${u.sent} × ${pct(rep.attLoss * 100, 3)} = ${u.exactLost.toFixed(3)} → <b>${u.lost}</b> ölü`),
    ...rep.animals.map((a) => `${a.tr}: ${a.count} × ${pct(rep.defLoss * 100, 3)} = ${a.exactKilled.toFixed(3)} → <b>${a.killed}</b> ölü (ödül ${fmt(a.killed * a.upkeep * 160)})`),
    'Her tür ayrı yuvarlanır; tam 0,5 saldırganda aşağı (resmî Hun rehberi), hayvanda yukarı (varsayım) yuvarlanır.',
  ];
  void x;
  return `<ol class="explain">${lines.map((l) => `<li>${l}</li>`).join('')}</ol>`;
}
function resultCard(rep, ctx = {}) {
  if (!rep || !rep.valid) return `<div class="card"><p class="muted">Geçerli bir saldırı yok: en az bir asker veya kahraman gerekli.</p></div>`;
  const st = statusOf(rep);
  const killedTxt = rep.animals.length ? rep.animals.map((a) => `${a.icon} ${a.killed}/${a.count}`).join(' &nbsp;') : 'hayvan yok';
  const lostTxt = rep.units.filter((u) => u.lost > 0).map((u) => `${u.lost} ${esc(u.tr)}`).join(', ') || 'Kayıp yok';
  const max = ctx.maxNet, base = ctx.maxProfitTroops;
  const lim = S.prefs.lossFilterOn ? pct(num(S.prefs.maxLossRatio), 0) : 'kapalı';
  let h = `<div class="card result">
  <div class="card-h"><h3>${esc(ctx.title || 'Savaş sonucu')}</h3><span class="badge ${st.cls}">${st.label}</span></div>
  ${ctx.sentence ? `<p class="sentence">${sentence(rep)}</p>` : `<p class="army">${armyLine(rep)}</p>`}
  <p class="status-text">${esc(st.text)}</p>
  <div class="grid2">
   <div><h4>Savaş sonucu</h4>
    ${row('Saldırı gücü', fmt(rep.off))}${row('Savunma gücü', fmt(rep.def))}
    ${row('Öldürülen hayvanlar', killedTxt)}${row('Kaybedilen askerler', lostTxt, rep.lossCost > 0 ? 'neg' : 'pos')}
    ${rep.hero ? row('Kahraman can kaybı <i>(tahmin)</i>', pct(rep.heroDamage)) + row('Kahraman savaş sonrası', rep.heroDead ? '☠ ÖLÜR' : pct(rep.heroAfter) + ` (önce ${pct(rep.hero.health, 0)})`, rep.heroDead ? 'neg' : '') : ''}
    ${row('Hayvan ödülü', fmt(rep.bountyNominal) + (rep.bountyNominal ? ` <small>(4×${fmt(rep.bountyPerResource)})</small>` : ''))}
    ${row('Normal yağma', fmt(rep.lootNominal) + ` <small>(kapasite ${fmt(rep.carry)})</small>`)}
    ${row('Asker kayıp maliyeti', fmt(rep.lossCostNominal), rep.lossCost > 0 ? 'neg' : '')}
    ${rep.extraCost ? row('Ek gerçek giderler', fmt(rep.extraCost)) : ''}
    ${row('Net kâr', signed(rep.net), rep.net > 0 ? 'pos big' : 'neg big')}
   </div>
   <div><h4>Ekonomik verimlilik</h4>
    ${row('Kayıp oranı (hayvan ödülüne)', rep.lossRatio == null ? 'uygulanamaz' : pct(rep.lossRatio, 2), rep.lossRatio != null && S.prefs.lossFilterOn && rep.lossRatio >= num(S.prefs.maxLossRatio) ? 'neg' : '')}
    ${row('İzin verilen azami kayıp', lim)}
    ${row('Genel kayıp oranı (ödül+yağma)', rep.overallRatio == null ? 'uygulanamaz' : pct(rep.overallRatio, 2))}
    ${row('Gönderilen toplam asker', fmt(rep.troops))}
    ${row('Bağlanan ordu değeri', fmt(rep.armyValue))}
    ${row('Ordu sermaye verimliliği', rep.efficiency == null ? '—' : pct(rep.efficiency, 2))}
    ${row('Asker başına net kâr', rep.perTroop == null ? '—' : fmt(rep.perTroop))}
    ${max ? row('En yüksek net kâra göre', pct((rep.net / max) * 100, 1)) : ''}
    ${base != null && base > 0 ? row('Asker tasarrufu (en kârlı orduya göre)', `${fmt(base - rep.troops)} asker (${pct((1 - rep.troops / base) * 100, 0)})`) : ''}
    ${rep.hours ? row('Gidiş-dönüş <i>(tahmin)</i>', formatHours(rep.hours)) + row('Saatlik net kâr (tek döngü)', fmt(rep.perHour)) : ''}
   </div>
  </div>
  <details><summary>Hesaplama nasıl yapıldı?</summary>${explain(rep)}</details>
  ${ctx.extra || ''}</div>`;
  return h;
}

// ---------- Sekme: VAHA ----------
function animalGrid() {
  const typ = S.oasis.type && OASIS_TYPES[S.oasis.type] ? OASIS_TYPES[S.oasis.type].typical : [];
  return `<div class="animals">${ANIMAL_IDS.map((id) => {
    const a = ANIMALS[id], v = int(S.oasis.animals[id]), c = S.oasis.conf[id];
    return `<div class="animal ${v > 0 ? 'on' : ''} ${c && c.confidence === 'low' ? 'low' : ''}">
      <label for="an-${id}"><span class="ico">${a.icon}</span> ${a.tr}${typ.includes(id) ? ' <small title="Bu vaha türünde yaygın">•</small>' : ''}</label>
      <div class="stepper"><button data-act="dec" data-id="${id}" aria-label="${a.tr} azalt">−</button>
      <input id="an-${id}" type="number" inputmode="numeric" min="0" value="${v || ''}" placeholder="0" data-animal="${id}">
      <button data-act="inc" data-id="${id}" aria-label="${a.tr} artır">+</button></div>
      ${c ? `<small class="conf ${c.confidence}">${c.confidence === 'high' ? 'okundu' : '⚠ kontrol et'}${c.note ? ' — ' + esc(c.note) : ''}</small>` : ''}
    </div>`; }).join('')}</div>`;
}
function oasisDefense() {
  const an = ANIMAL_IDS.reduce((s, id) => s + int(S.oasis.animals[id]) * ANIMALS[id].defCav, 0);
  const up = ANIMAL_IDS.reduce((s, id) => s + int(S.oasis.animals[id]) * ANIMALS[id].upkeep, 0);
  return `Süvariye karşı savunma: <b>${fmt(an + 10)}</b> (hayvanlar ${fmt(an)} + 10 taban) · Hepsi ölürse ödül: <b>${fmt(up * 160)}</b>`;
}
function tabOasis() {
  const hm = S.prefs.heroMode, v = T.visionMsg;
  return `
  <section class="card">
    <div class="card-h"><h3>1 · Vaha ekran görüntüsü</h3></div>
    <div class="row">
      <label class="btn file">📷 Görüntü seç<input type="file" accept="image/*" id="img-oasis" hidden></label>
      <button class="btn" data-act="vision-ai" ${T.image && !T.visionBusy ? '' : 'disabled'}>Yapay zekâ ile tanı</button>
      <button class="btn ghost" data-act="vision-ocr" ${T.image && !T.visionBusy ? '' : 'disabled'}>Cihazda OCR <small>(deneysel)</small></button>
    </div>
    ${T.image ? `<img class="thumb" src="${T.image.url}" alt="Yüklenen vaha görüntüsü">` : '<p class="muted">Vahaya tıklayınca açılan, hayvanların listelendiği pencerenin görüntüsünü yükleyin. Tanıma olmadan da aşağıdan elle girebilirsiniz.</p>'}
    ${T.visionBusy ? '<p class="muted">Tanınıyor…</p>' : ''}
    ${v ? `<div class="note ${v.cls}">${v.html}</div>` : ''}
    <details><summary>Metinden oku (yapıştır)</summary>
      <textarea id="paste-text" rows="3" placeholder="Örn.&#10;3 Sıçan&#10;1 Örümcek&#10;9 Yarasa"></textarea>
      <button class="btn ghost" data-act="parse-text">Metni uygula</button></details>
  </section>
  <section class="card">
    <div class="card-h"><h3>2 · Vahadaki hayvanlar</h3><button class="link" data-act="clear-animals">Temizle</button></div>
    ${animalGrid()}
    <p class="muted" id="def-line">${oasisDefense()}</p>
    <details ${S.oasis.type || coordsOk(S.oasis.coords) ? 'open' : ''}><summary>Vaha bilgisi, koordinat ve birikmiş hammadde</summary>
      <div class="fields">
        <label>Vaha türü <small>(savaşı etkilemez)</small><select data-bind="oasis.type" data-rerender>
          <option value="">— seçilmedi —</option>${OASIS_TYPE_IDS.map((id) => `<option value="${id}" ${S.oasis.type === id ? 'selected' : ''}>${OASIS_TYPES[id].tr}</option>`).join('')}</select></label>
        <label>Vaha X<input type="number" inputmode="numeric" data-bind="oasis.coords.x" data-raw value="${esc(S.oasis.coords.x)}"></label>
        <label>Vaha Y<input type="number" inputmode="numeric" data-bind="oasis.coords.y" data-raw value="${esc(S.oasis.coords.y)}"></label>
      </div>
      <p class="muted">Normal yağma için vahada birikmiş (bilinen/tahmini) hammadde:</p>
      <div class="fields four">${['Odun', 'Kil', 'Demir', 'Tahıl'].map((n, i) => `<label>${n}<input type="number" inputmode="numeric" min="0" data-bind="oasis.stock.${i}" value="${int(S.oasis.stock[i]) || ''}" placeholder="0"></label>`).join('')}</div>
      <div class="row"><label class="inline">Son temizlikten beri saat<input type="number" inputmode="decimal" min="0" data-bind="oasis.hours" value="${num(S.oasis.hours) || ''}" placeholder="0"></label>
      <button class="btn ghost" data-act="estimate-stock" ${S.oasis.type ? '' : 'disabled'}>Üretimden tahmin et</button>
      <button class="btn ghost" data-act="save-oasis">Vahayı listeye kaydet</button></div>
    </details>
  </section>
  <section class="card">
    <div class="card-h"><h3>3 · Ordu ve kahraman</h3><button class="link" data-tab="profile">Profili düzenle</button></div>
    <p class="muted">Kullanılabilir: <b>${int(S.profile.troops.steppeRider)}</b> Bozkır Atlısı · <b>${int(S.profile.troops.marksman)}</b> Nişancı · <b>${int(S.profile.troops.marauder)}</b> Yağmacı — Kahraman: güç ${fmt(num(S.profile.hero.strength))}, sağlık ${pct(num(S.profile.hero.health), 0)}</p>
    <div class="seg" role="group" aria-label="Kahraman katılımı">
      ${[['none', 'Kahramansız'], ['with', 'Kahramanla'], ['alone', 'Yalnız kahraman']].map(([k, l]) => `<button data-act="hero-mode" data-id="${k}" class="${hm === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div class="seg small" role="group" aria-label="Saldırı türü">
      ${[['raid', 'Yağma'], ['attack', 'Normal saldırı']].map(([k, l]) => `<button data-act="attack-mode" data-id="${k}" class="${S.prefs.attackMode === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <button class="btn primary big" data-act="optimize" ${T.busy ? 'disabled' : ''}>${T.busy ? `Hesaplanıyor… ${Math.round(T.progress * 100)}%` : '⚔ En İyi Kadroyu Bul'}</button>
  </section>
  <div id="results">${renderResults()}</div>`;
}

const PICK_LABELS = {
  balanced: ['Dengeli öneri', 'Az askerle yüksek kâr: en yüksek net kârın eşik yüzdesini sağlayan, en az ordu sermayesi bağlayan kadro.'],
  maxProfit: ['En yüksek net kâr', 'Kayıp sınırına uyan en yüksek mutlak kâr (eşitlikte daha ucuz ordu).'],
  minTroops: ['Minimum asker', 'Kâr eşiğini sağlayan en az sayıda asker.'],
  zeroLoss: ['Sıfır asker kaybı', 'Hiç asker kaybetmeyen en ekonomik küçük ordu.'],
  maxEfficiency: ['En yüksek sermaye verimliliği', 'Net kâr / bağlanan ordu değeri en yüksek kadro.'],
  lowHeroRisk: ['En düşük kahraman riski', 'Kâr eşiğini sağlarken kahramanın en az can kaybettiği kadro.'],
  maxPerHour: ['En yüksek saatlik kâr', 'Tek döngüde saat başına en yüksek net kâr (yolculuk süresi tahmini).'],
  saferBalanced: ['Daha güvenli dengeli', 'Dengeli önerinin yuvarlama sınırından uzak alternatifi.'],
  smallArmy: ['Küçük ordu fırsatı', 'En yüksek kârın en az %75\'ini, en kârlı ordunun en çok %20\'si kadar askerle sağlar.'],
};
function repFor(counts, withHero) {
  const cfg = baseConfig(OPT_UNIT_IDS, S.prefs.attackMode);
  cfg.hero = withHero ? heroCfg() : null;
  return createScenario(cfg).report(counts);
}
function renderResults() {
  const R = T.result;
  if (!R) return '';
  if (R.error) return `<div class="card"><div class="note bad">${esc(R.error)}</div></div>`;
  const hm = R.heroMode, opt = hm === 'with' ? R.withHero : R.noHero, withHero = hm === 'with';
  let h = '';
  if (hm === 'alone') {
    const rep = R.heroAlone, p = prefsCfg();
    const unsafe = rep.heroDead || rep.heroAfter < p.minHeroHealth;
    T.lastReport = rep;
    h += resultCard(rep, { title: 'Kahraman tek başına', sentence: true, extra: unsafe ? `<div class="note bad">Güvenli değil: ${rep.heroDead ? 'kahramanın ölmesi bekleniyor' : `savaş sonrası sağlık asgari sınırın (${pct(p.minHeroHealth, 0)}) altında`}. Can hesabı doğrulanmamış bir tahmindir.</div>` : '' });
  } else {
    const scope = `${opt.exhaustive ? 'Eksiksiz arama' : 'SINIRLI arama'}: 0–${opt.limits[0]} Bozkır × 0–${opt.limits[1]} Nişancı × 0–${opt.limits[2]} Yağmacı = ${fmt(opt.searched)} kombinasyon, ${opt.ms} ms. ${opt.exhaustive ? 'Sonuçlar bu sınırlar içinde kesin optimumdur (motor modeline göre).' : `İstenen sınırlar (${opt.requested.join('/')}) çok büyük olduğu için küçültüldü; sonuç kesin optimum olmayabilir.`}`;
    const picks = opt.picks, mode = picks[S.prefs.pickMode] ? S.prefs.pickMode : 'balanced';
    const main = picks[mode];
    if (!main) {
      const st = opt.stats;
      h += `<div class="card"><div class="card-h"><h3>Uygun kadro bulunamadı</h3></div>
        <div class="note bad">Filtreleri geçen kombinasyon yok. Değerlendirilen ${fmt(st.evaluated)} adaydan ${fmt(st.byLoss)} tanesi kayıp oranı sınırına (${S.prefs.lossFilterOn ? pct(num(S.prefs.maxLossRatio), 0) : 'kapalı'}), ${fmt(st.byProfit)} tanesi kâr şartına${withHero ? `, ${fmt(st.byHero)} tanesi kahraman güvenliğine` : ''} takıldı.
        ${ANIMAL_IDS.every((id) => !int(S.oasis.animals[id])) && !S.oasis.stock.some((v) => int(v) > 0) ? ' Vahada hayvan ve birikmiş hammadde girilmediği için kazanılacak bir şey yok.' : ' Bu vaha mevcut ordunuzla ekonomik değil; daha fazla asker, kahraman veya daha yüksek kayıp sınırı deneyebilirsiniz.'}</div>
        <p class="muted">${scope}</p>
        ${opt.rejectedBest.length ? `<h4>Filtre dışı en iyi adaylar</h4>${opt.rejectedBest.map((c) => altRow(repFor(c.counts, withHero), { tag: { loss: 'kayıp oranı', profit: 'kârsız', hero: 'kahraman riski' }[c.reason] })).join('')}` : ''}</div>`;
    } else {
      const rep = repFor(main.counts, withHero);
      T.lastReport = rep;
      const ctx = { maxNet: opt.maxNet, maxProfitTroops: picks.maxProfit.troops };
      const extra = `<p class="muted">${PICK_LABELS[mode][1]} Kâr eşiği: en yüksek net kârın ${pct(opt.prefs.profitThresholdPct, 0)} düzeyi (≥ ${fmt(opt.threshold)}). ${scope}</p>` +
        (picks.saferBalanced && mode === 'balanced' ? `<div class="note warn">Bu öneri yuvarlama sınırına yakın. Daha güvenli alternatif: ${armyLine(repFor(picks.saferBalanced.counts, withHero))} (net ${signed(picks.saferBalanced.net)}).</div>` : '') +
        (main.borderline && mode === 'balanced' && !picks.saferBalanced ? '<div class="note warn">Bu öneri yuvarlama sınırına yakın ve mevcut asker sınırları içinde aynı kâr eşiğini sağlayan, sınırdan uzak bir alternatif yok. Sonuç bir asker kaybıyla farklı çıkabilir.</div>' : '') +
        (!picks.zeroLoss ? '<div class="note">Bu sınırlar içinde sıfır asker kaybı veren uygun bir kadro yok.</div>' : '') +
        (picks.smallArmy ? `<div class="note ok">Küçük ordu fırsatı: ${armyLine(repFor(picks.smallArmy.counts, withHero))} — net ${signed(picks.smallArmy.net)} (en yüksek kârın ${pct((picks.smallArmy.net / opt.maxNet) * 100, 0)} düzeyi), en kârlı ordunun ${pct((picks.smallArmy.troops / picks.maxProfit.troops) * 100, 0)} kadarı askerle.</div>` : '');
      h += resultCard(rep, { ...ctx, title: 'Önerilen ordu — ' + PICK_LABELS[mode][0], sentence: true, extra });
      // Adlandırılmış alternatifler
      const order = ['balanced', 'maxProfit', 'minTroops', 'zeroLoss', 'maxEfficiency', 'lowHeroRisk', 'maxPerHour', 'saferBalanced', 'smallArmy'];
      h += `<div class="card"><div class="card-h"><h3>Alternatif stratejiler</h3></div>` +
        order.filter((k) => picks[k]).map((k) => altRow(repFor(picks[k].counts, withHero), { tag: PICK_LABELS[k][0], ctx, active: k === mode, pick: k })).join('') + `</div>`;
      const used = new Set(order.filter((k) => picks[k]).map((k) => picks[k].counts.join('/')));
      const others = opt.pareto.filter((p) => !used.has(p.counts.join('/'))).slice(0, 5);
      if (others.length) h += `<div class="card"><div class="card-h"><h3>Diğer Pareto-optimal kadrolar (ilk ${others.length} / ${opt.paretoCount})</h3></div>
        <p class="muted">Hiçbiri bir diğerinden bütün ölçütlerde (net kâr, asker sayısı, ordu değeri, kayıp, kahraman canı, saatlik kâr, sınırda olma) kötü değildir.</p>
        ${others.map((p) => altRow(repFor(p.counts, withHero), { ctx })).join('')}</div>`;
    }
  }
  if (R.withHero) h += heroCompare(R);
  return h;
}
function altRow(rep, o = {}) {
  const st = statusOf(rep);
  return `<details class="alt ${o.active ? 'active' : ''}"><summary>
    <span class="alt-army">${armyLine(rep)}${o.tag ? ` <em>${esc(o.tag)}</em>` : ''}</span>
    <span class="alt-nums"><b class="${rep.net > 0 ? 'pos' : 'neg'}">${signed(rep.net)}</b> · kayıp ${rep.lossRatio == null ? '—' : pct(rep.lossRatio, 1)} · ${fmt(rep.troops)} asker${rep.hero ? ` · HP −${pct(rep.heroDamage)}` : ''} <span class="dot ${st.cls}" title="${st.label}"></span></span></summary>
    ${o.pick && !o.active ? `<button class="btn ghost" data-act="pick-mode" data-id="${o.pick}">Bunu varsayılan öneri yap</button>` : ''}
    ${resultCard(rep, { ...(o.ctx || {}), title: 'Ayrıntı' })}</details>`;
}
function heroCompare(R) {
  const rows = [];
  const add = (label, rep) => rows.push(`<tr><td>${label}</td><td>${rep ? armyLine(rep) : '—'}</td><td>${rep ? fmt(rep.lossCostNominal) : '—'}</td><td>${rep ? fmt(rep.bountyNominal) : '—'}</td><td class="${rep && rep.net > 0 ? 'pos' : 'neg'}">${rep ? signed(rep.net) : '—'}</td><td>${rep && rep.hero ? (rep.heroDead ? '☠ ölür' : '−' + pct(rep.heroDamage) + ' → ' + pct(rep.heroAfter)) : '—'}</td></tr>`);
  const a = R.noHero.picks.balanced ? repFor(R.noHero.picks.balanced.counts, false) : null;
  const b = R.withHero.picks.balanced ? repFor(R.withHero.picks.balanced.counts, true) : null;
  add('Kahramansız (dengeli)', a); add('Kahramanla (dengeli)', b); add('Yalnız kahraman', R.heroAlone);
  let note = '';
  if (a && b) {
    const same = repFor(b.counts, false);
    note = `<p class="muted">Kahramanın katkısı: dengeli öneride net kâr farkı <b>${signed(b.net - a.net)}</b>, ordu ${fmt(a.troops)} → ${fmt(b.troops)} asker. Aynı kadroyla (${b.counts.join('/')}) kahramansız gidilseydi asker kayıp maliyeti ${fmt(same.lossCostNominal)} olurdu; kahramanla ${fmt(b.lossCostNominal)}. Karşılığında kahraman tahminen ${pct(b.heroDamage)} can kaybeder. Sağlık kaybı hammaddeye çevrilmez; yalnızca asgari sağlık sınırınıza (${pct(num(S.prefs.minHeroHealth), 0)}) göre süzülür.</p>`;
  }
  return `<div class="card"><div class="card-h"><h3>Kahramanlı / kahramansız karşılaştırma</h3><span class="badge warn">HP: model tahmini</span></div>
    <div class="scroll"><table><thead><tr><th>Seçenek</th><th>Ordu</th><th>Asker kaybı</th><th>Hayvan ödülü</th><th>Net kâr</th><th>Kahraman HP</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>${note}
    <p class="muted">Kahraman can kaybı formülü resmî olarak belgelenmemiştir; burada "saldırgan kayıp yüzdesi kadar can" modeli kullanılır. Gerçek savaş raporlarınızla karşılaştırıp Ayarlar → Referans vakalar bölümüne not edin.</p></div>`;
}

// ---------- Sekme: SİMÜLATÖR ----------
function tabSim() {
  const hm = S.prefs.heroMode;
  return `<section class="card"><div class="card-h"><h3>Savaş simülatörü</h3><button class="link" data-act="sim-from-rec" ${T.lastReport ? '' : 'disabled'}>Öneriyi yükle</button></div>
    <p class="muted">Savunan: Vaha sekmesindeki hayvanlar — ${ANIMAL_IDS.filter((id) => int(S.oasis.animals[id])).map((id) => `${ANIMALS[id].icon} ${int(S.oasis.animals[id])}`).join(' ') || 'hayvan yok'}. ${oasisDefense()}</p>
    <div class="fields">${ALL_HUN_IDS.map((id) => `<label>${HUN_UNITS[id].tr} <small>(${HUN_UNITS[id].attack})</small><input type="number" inputmode="numeric" min="0" data-bind="sim.units.${id}" value="${int(S.sim.units[id]) || ''}" placeholder="0"></label>`).join('')}</div>
    <div class="seg small">${[['raid', 'Yağma'], ['attack', 'Normal saldırı']].map(([k, l]) => `<button data-act="sim-mode" data-id="${k}" class="${S.sim.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="seg small">${[['none', 'Kahramansız'], ['with', 'Kahraman katılıyor']].map(([k, l]) => `<button data-act="hero-mode" data-id="${k}" class="${(hm === 'none') === (k === 'none') ? 'on' : ''}">${l}</button>`).join('')}</div>
    <button class="btn primary" data-act="simulate">Simüle et</button></section>
  <div id="sim-out">${T.simReport ? resultCard(T.simReport, { title: 'Simülasyon sonucu', extra: refForm(T.simReport) }) : ''}</div>`;
}
function refForm(rep) {
  if (rep.hero) return '<p class="muted">Referans vaka kaydı kahramansız savaşlar içindir.</p>';
  return `<details><summary>Gerçek oyun sonucuyla karşılaştır / referans olarak kaydet</summary>
    <p class="muted">Oyundaki simülatörün veya savaş raporunun gösterdiği GERÇEK değerleri girin. Motorla uyuşmazsa burada görünür ve Ayarlar'da listelenir.</p>
    <div class="fields">${rep.units.map((u) => `<label>Ölen ${esc(u.tr)}<input type="number" min="0" data-ref-lost="${u.id}" value="${u.lost}"></label>`).join('')}
    ${rep.animals.map((a) => `<label>Ölen ${esc(a.tr)}<input type="number" min="0" data-ref-killed="${a.id}" value="${a.killed}"></label>`).join('')}
    <label>Ad / not<input type="text" id="ref-name" placeholder="örn. (52|50) 12/0/3"></label></div>
    <button class="btn ghost" data-act="save-ref">Referans olarak kaydet</button></details>`;
}

// ---------- Sekme: RAINBOW ----------
function tabRainbow() {
  const tr = travelCfg(), p = S.profile, hc = heroCfg();
  let body = '<p class="muted">Köy ve vaha koordinatlarını girince mesafe, yolculuk süresi ve saatlik verim hesaplanır.</p>';
  if (tr) {
    const f = tr.speedFactor;
    const rowsU = OPT_UNIT_IDS.map((id) => { const sp = HUN_UNITS[id].speed * f; const h = tripHours(tr.distance, sp, tr.tsLevel); return `<tr><td>${HUN_UNITS[id].tr}</td><td>${sp} kare/sa</td><td>${formatHours(h / 2)}</td><td>${formatHours(h)}</td><td>${HUN_UNITS[id].carry}</td></tr>`; }).join('');
    const hs = (Math.min(hc.speed, 14) + 3) * f;
    body = `<p>Mesafe: <b>${tr.distance.toFixed(2).replace('.', ',')}</b> kare ${tr.distance > 20 && tr.tsLevel ? `(20 kareden sonrası Turnuva Alanı ${tr.tsLevel} ile ×${(1 + 0.2 * tr.tsLevel).toFixed(1)})` : ''}</p>
      <div class="scroll"><table><thead><tr><th>Birim</th><th>Hız (x${f})</th><th>Tek yön</th><th>Gidiş-dönüş</th><th>Taşıma</th></tr></thead><tbody>${rowsU}
      <tr><td>Kahraman + süvari (en yavaş Yağmacı)</td><td>${hs} kare/sa</td><td>${formatHours(tripHours(tr.distance, hs, tr.tsLevel) / 2)}</td><td>${formatHours(tripHours(tr.distance, hs, tr.tsLevel))}</td><td>0</td></tr></tbody></table></div>`;
    const rep = T.lastReport;
    if (rep && rep.valid && rep.hours) body += `<h4>Seçili ordu: ${armyLine(rep)}</h4>
      ${row('Gidiş-dönüş / tekrar kullanılabilirlik', formatHours(rep.hours))}${row('Taşıma kapasitesi (sağ kalanlar)', fmt(rep.carry))}
      ${row('Taşınan normal yağma', fmt(rep.lootNominal))}${row('Kahraman heybesine hayvan ödülü', fmt(rep.bountyNominal))}
      ${row('Saldırı başına net kâr', signed(rep.net))}${row('Saatlik net kâr (tek döngü)', fmt(rep.perHour))}${row('Asker başına saatlik kâr', rep.troops ? (rep.perHour / rep.troops).toFixed(1).replace('.', ',') : '—')}`;
    else body += '<p class="muted">Saatlik kâr için Vaha sekmesinde bir kadro bulun veya Simülatör\'de simüle edin.</p>';
  }
  const vil = coordsOk(p.village) ? { x: +p.village.x, y: +p.village.y } : null;
  const list = S.oases.map((o, i) => ({ o, i, d: vil && coordsOk(o.coords) ? distance(vil, { x: +o.coords.x, y: +o.coords.y }) : null })).sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
  return `<section class="card"><div class="card-h"><h3>Rainbow Village — yolculuk ve verim</h3><span class="badge est">süreler tahmin</span></div>
    <div class="fields">
      <label>Köy X<input type="number" data-bind="profile.village.x" data-raw data-rerender value="${esc(p.village.x)}"></label>
      <label>Köy Y<input type="number" data-bind="profile.village.y" data-raw data-rerender value="${esc(p.village.y)}"></label>
      <label>Vaha X<input type="number" data-bind="oasis.coords.x" data-raw data-rerender value="${esc(S.oasis.coords.x)}"></label>
      <label>Vaha Y<input type="number" data-bind="oasis.coords.y" data-raw data-rerender value="${esc(S.oasis.coords.y)}"></label>
      <label>Turnuva Alanı seviyesi<input type="number" min="0" max="20" data-bind="profile.tsLevel" data-rerender value="${int(p.tsLevel)}"></label>
      <label>Birim hızı çarpanı <small>(x2 sunucu → 2)</small><input type="number" min="1" step="0.5" data-bind="profile.unitSpeedFactor" data-rerender value="${num(p.unitSpeedFactor, 2)}"></label>
    </div>${body}
    <p class="muted">Resmî kaynaklar yolculuk formülü vermez; süreler topluluk formülüyle hesaplanır (en yavaş birim × hız çarpanı; Hun kahramanı yalnızca süvariyle +3). Kesin süre için oyundaki Toplanma Yeri'ni esas alın.</p></section>
  <section class="card"><div class="card-h"><h3>Kayıtlı vahalar (${S.oases.length})</h3></div>
    ${list.length ? `<div class="scroll"><table><thead><tr><th>Vaha</th><th>Hayvanlar</th><th>Mesafe</th><th>Yağmacıyla g-d</th><th></th></tr></thead><tbody>${list.map(({ o, i, d }) => `<tr><td>(${esc(o.coords.x)}|${esc(o.coords.y)})<br><small>${esc(o.type && OASIS_TYPES[o.type] ? OASIS_TYPES[o.type].tr : '')}</small></td><td>${ANIMAL_IDS.filter((id) => o.animals[id] > 0).map((id) => `${ANIMALS[id].icon}${o.animals[id]}`).join(' ') || '—'}</td><td>${d == null ? '—' : d.toFixed(1).replace('.', ',')}</td><td>${d == null ? '—' : formatHours(tripHours(d, 14 * num(p.unitSpeedFactor, 2), int(p.tsLevel)))}</td><td><button class="link" data-act="load-oasis" data-id="${i}">Yükle</button> <button class="link" data-act="del-oasis" data-id="${i}">Sil</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Vaha sekmesinden "Vahayı listeye kaydet" ile ekleyin. Yakın vahalar üstte sıralanır.</p>'}
  </section>
  <section class="card"><div class="card-h"><h3>Vaha üretimi ve hayvan yenilenmesi</h3></div>
    <ul class="plain"><li>Hayvan ödülü <b>tek seferliktir</b> (öldürülen hayvan başına); düzenli yağma geliri vahanın biriken hammaddesinden gelir. İkisi ayrı hesaplanır.</li>
    <li>Boş vaha üretimi (1x): ana hammadde 40/sa, diğerleri 10/sa; x2 sunucuda iki katı. Depo: tek bonuslu 1.000, çift bonuslu/%50 2.000 (hammadde başına; hızla ölçeklenmesi kaynakta belirtilmiyor).</li>
    <li>Resmî kaynak: vaha üretimi, ilk hayvanların tamamı temizlendikten sonra başlar.</li>
    <li>Hayvanların yeniden doğma aralığı ve sayısı resmî kaynaklarda <b>verilmiyor</b>; bu yüzden uygulama yeniden doğmayı tahmin etmez. Her saldırıdan önce güncel hayvan sayısını girin.</li></ul></section>`;
}

// ---------- Sekme: PROFİL ----------
function tabProfile() {
  const p = S.profile, h = p.hero;
  return `<section class="card"><div class="card-h"><h3>Kullanılabilir askerler ve demirci</h3></div>
    <div class="scroll"><table class="form"><thead><tr><th>Asker</th><th>Adet</th><th>Demirci (0–20)</th></tr></thead><tbody>
    ${OPT_UNIT_IDS.map((id) => `<tr><td>${HUN_UNITS[id].tr}<br><small>saldırı ${HUN_UNITS[id].attack} · maliyet ${fmt(HUN_UNITS[id].cost.reduce((a, b) => a + b))} · hız ${HUN_UNITS[id].speed} · taşıma ${HUN_UNITS[id].carry}</small></td>
      <td><input type="number" inputmode="numeric" min="0" data-bind="profile.troops.${id}" value="${int(p.troops[id])}" aria-label="${HUN_UNITS[id].tr} adedi"></td>
      <td><input type="number" inputmode="numeric" min="0" max="20" data-bind="profile.smithy.${id}" value="${int(p.smithy[id])}" aria-label="${HUN_UNITS[id].tr} demirci seviyesi"></td></tr>`).join('')}</tbody></table></div>
    <div class="fields"><label>Ek ordu saldırı bonusu % <small>(ittifak vb.)</small><input type="number" min="0" step="0.1" data-bind="profile.otherAttackBonusPct" value="${num(p.otherAttackBonusPct)}"></label></div>
  </section>
  <section class="card"><div class="card-h"><h3>Kahraman</h3><span class="badge warn">HP: model tahmini</span></div>
    <div class="row"><label class="btn file ghost">📷 Kahraman ekranından oku<input type="file" accept="image/*" id="img-hero" hidden></label></div>
    <div class="fields">
      <label>Savaş gücü <small>(oyundaki toplam, silah dahil)</small><input type="number" min="0" data-bind="profile.hero.strength" value="${num(h.strength)}"></label>
      <label>Sağlık %<input type="number" min="0" max="100" data-bind="profile.hero.health" value="${num(h.health)}"></label>
      <label>Seviye<input type="number" min="0" data-bind="profile.hero.level" value="${int(h.level)}"></label>
      <label>Saldırı bonusu % <small>(ordu)</small><input type="number" min="0" step="0.2" data-bind="profile.hero.offBonusPct" value="${num(h.offBonusPct)}"></label>
      <label>Sağ el silahı<select data-bind="profile.hero.weaponId">${Object.values(HUN_WEAPONS).map((w) => `<option value="${w.id}" ${h.weaponId === w.id ? 'selected' : ''}>${w.tr}${w.unit ? ` (+${w.perUnit}/${HUN_UNITS[w.unit].tr})` : ''}</option>`).join('')}</select></label>
      <label>Zırh hasar azaltma <small>(can puanı)</small><input type="number" min="0" data-bind="profile.hero.armorReduction" value="${num(h.armorReduction)}"></label>
      <label>Kahraman hızı <small>(kare/sa, 1x)</small><input type="number" min="1" data-bind="profile.hero.speed" value="${num(h.speed, 14)}"></label>
      <label>Can yenilenme %/gün<input type="number" min="0" data-bind="profile.hero.regenPct" value="${num(h.regenPct, 10)}"></label>
      <label class="check"><input type="checkbox" data-bind="profile.hero.mounted" ${h.mounted ? 'checked' : ''}> Atlı (süvari sayılır)</label>
      <label class="wide">Diğer ekipman / notlar<input type="text" data-bind="profile.hero.notes" data-raw value="${esc(h.notes)}"></label>
    </div>
    <p class="muted">Kahraman, mevcut sağlığından bağımsız olarak tam güçle dövüşür; tek savaşta %90 ve üzeri can kaybı ölümdür (resmî). Silahın birim başına bonusu yalnızca kahraman o orduyla gidiyorsa uygulanır. Sol el eşyaları ve kalkanlar saldırı gücünü etkilemez; ordu saldırı bonusu veren eşyaları "Saldırı bonusu %" alanına ekleyin. Günde %${num(h.regenPct, 10)} yenilenmeyle %${num(S.prefs.minHeroHealth)} → %100 yaklaşık ${((100 - num(S.prefs.minHeroHealth)) / Math.max(num(h.regenPct, 10), 0.01)).toFixed(1).replace('.', ',')} gün sürer.</p>
  </section>
  <section class="card"><div class="card-h"><h3>Sunucu ve köy</h3></div>
    <div class="fields">
      <label class="wide">Sunucu<input type="text" data-bind="profile.server" data-raw value="${esc(p.server)}"></label>
      <label>Sunucu hızı <small>(vaha üretimi)</small><input type="number" min="1" data-bind="profile.serverSpeed" value="${num(p.serverSpeed, 2)}"></label>
      <label>Birim hızı çarpanı<input type="number" min="1" step="0.5" data-bind="profile.unitSpeedFactor" value="${num(p.unitSpeedFactor, 2)}"></label>
      <label>Köy X<input type="number" data-bind="profile.village.x" data-raw value="${esc(p.village.x)}"></label>
      <label>Köy Y<input type="number" data-bind="profile.village.y" data-raw value="${esc(p.village.y)}"></label>
      <label>Turnuva Alanı<input type="number" min="0" max="20" data-bind="profile.tsLevel" value="${int(p.tsLevel)}"></label>
    </div><p class="muted">Sunucu hızı askerlerin saldırı gücünü ve hayvan ödülünü değiştirmez; yalnızca vaha üretimini ve (çarpan üzerinden) yolculuk hızını etkiler.</p></section>`;
}

// ---------- Sekme: AYARLAR ----------
function tabSettings() {
  const pr = S.prefs, v = S.vision;
  const refs = [...REFERENCE_CASES.map((r) => ({ r, builtin: true })), ...S.refs.map((r, i) => ({ r, i }))];
  return `<section class="card"><div class="card-h"><h3>Optimizasyon tercihleri</h3></div>
    <div class="fields">
      <label class="check"><input type="checkbox" data-bind="prefs.lossFilterOn" ${pr.lossFilterOn ? 'checked' : ''}> Kayıp oranı filtresi açık</label>
      <label>Azami kayıp oranı % <small>(kayıp maliyeti / hayvan ödülü)</small><input type="number" min="0" data-bind="prefs.maxLossRatio" value="${num(pr.maxLossRatio, 50)}"></label>
      <label>Kâr eşiği % <small>(50–100, en yüksek kâra göre)</small><input type="number" min="50" max="100" data-bind="prefs.profitThresholdPct" value="${num(pr.profitThresholdPct, 90)}"></label>
      <label>Asgari savaş sonrası kahraman sağlığı %<input type="number" min="0" max="100" data-bind="prefs.minHeroHealth" value="${num(pr.minHeroHealth, 30)}"></label>
      <label class="check"><input type="checkbox" data-bind="prefs.requireProfit" ${pr.requireProfit ? 'checked' : ''}> Kârsız seçenekleri ele</label>
      <label>Varsayılan öneri modu<select data-bind="prefs.pickMode">${['balanced', 'maxProfit', 'minTroops', 'zeroLoss', 'maxEfficiency', 'lowHeroRisk', 'maxPerHour'].map((k) => `<option value="${k}" ${pr.pickMode === k ? 'selected' : ''}>${PICK_LABELS[k][0]}</option>`).join('')}</select></label>
      <label>Saldırı başına ek gerçek gider <small>(merhem vb.)</small><input type="number" min="0" data-bind="prefs.extraCost" value="${num(pr.extraCost)}"></label>
    </div>
    <p class="muted">Hammadde değer ağırlıkları (varsayılan 1 = nominal toplam):</p>
    <div class="fields four">${['Odun', 'Kil', 'Demir', 'Tahıl'].map((n, i) => `<label>${n}<input type="number" min="0" step="0.1" data-bind="prefs.weights.${i}" value="${num(pr.weights[i], 1)}"></label>`).join('')}</div>
  </section>
  <section class="card"><div class="card-h"><h3>Görüntü tanıma</h3><span class="badge est">haricî servis — isteğe bağlı</span></div>
    <p class="muted">"Yapay zekâ ile tanı" seçeneği, yüklediğiniz ekran görüntüsünü <b>kendi API anahtarınızla doğrudan Anthropic API'sine</b> gönderir (ikon + sayı tanıma). Anahtar yalnızca bu cihazda saklanır; başka hiçbir veri gönderilmez. Onay vermezseniz görüntü cihazdan çıkmaz; cihaz içi OCR ve elle giriş her zaman kullanılabilir. Ret durumunda sunucu taraflı model yedeği etkindir.</p>
    <div class="fields">
      <label class="check wide"><input type="checkbox" data-bind="vision.consent" ${v.consent ? 'checked' : ''}> Görüntülerimin Anthropic API'sine gönderilmesine izin veriyorum</label>
      <label class="wide">Anthropic API anahtarı<input type="password" autocomplete="off" data-bind="vision.apiKey" data-raw value="${esc(v.apiKey)}" placeholder="sk-ant-…"></label>
      <label class="wide">Model<select data-bind="vision.model">${VISION_MODELS.map((m) => `<option value="${m.id}" ${v.model === m.id ? 'selected' : ''}>${m.tr}</option>`).join('')}</select></label>
    </div></section>
  <section class="card"><div class="card-h"><h3>Referans vakalar (gerçek oyun sonuçları)</h3></div>
    ${refs.map(({ r, builtin, i }) => { const c = checkReference(r); return `<div class="ref"><span class="dot ${c.ok ? 'ok' : 'bad'}"></span><div><b>${esc(r.name)}</b>${builtin ? ' <small>(yerleşik)</small>' : ''}<br><small>${c.ok ? 'Motor birebir üretiyor.' : 'UYUŞMAZLIK — ' + esc(c.mismatches.join('; '))}</small></div>${builtin ? '' : `<button class="link" data-act="del-ref" data-id="${i}">Sil</button>`}</div>`; }).join('')}
    <p class="muted">Yeni vaka: Simülatör'de savaşı simüle edin → "Gerçek oyun sonucuyla karşılaştır". Uyuşmayan vakalar motorun o durumda yanlış olduğunu gösterir; lütfen bildirin.</p></section>
  <section class="card"><div class="card-h"><h3>Geçmiş (${S.history.length})</h3>${S.history.length ? '<button class="link" data-act="clear-history">Temizle</button>' : ''}</div>
    ${S.history.length ? S.history.slice(0, 30).map((x) => `<div class="hist"><small>${new Date(x.t).toLocaleString('tr-TR')}</small> ${esc(x.oasis)} → <b>${esc(x.army)}</b> · net ${signed(x.net)}${x.ratio != null ? ' · kayıp ' + pct(x.ratio, 1) : ''}</div>`).join('') : '<p class="muted">Henüz kayıt yok.</p>'}</section>
  <section class="card"><div class="card-h"><h3>Veri</h3></div>
    <div class="row"><button class="btn ghost" data-act="export">Dışa aktar (JSON)</button><label class="btn file ghost">İçe aktar<input type="file" accept="application/json,.json" id="import-file" hidden></label><button class="btn ghost danger" data-act="reset">Tümünü sıfırla</button></div>
    <p class="muted">Bütün veriler yalnızca bu cihazda (tarayıcı deposu) tutulur. Uygulama Travian hesabınıza giriş yapmaz, şifre istemez, saldırı göndermez.</p></section>
  <section class="card"><div class="card-h"><h3>Doğrulananlar ve belirsizlikler</h3></div>
    <ul class="plain">
      <li><b>Doğrulandı:</b> yağma kayıp formülü, birim bazlı yuvarlama, +10 vaha taban savunması, sıçan/örümcek/yarasa süvari savunmaları, hayvan ödülü (tüketim başına 4×40) — iki gerçek simülasyonunuzla birebir.</li>
      <li><b>Resmî kaynakla uyumlu:</b> 1/1/1 kadrosu 410 savunmaya kadar kayıpsız (tam 0,5 → saldırgan lehine).</li>
      <li><b>Varsayım:</b> hayvan kaybında tam 0,5 yukarı yuvarlanır; demirci formülünde yuvarlama yok; 1000+ birimli savaşlarda K üssü yağmada da kullanılır.</li>
      <li><b>Model tahmini:</b> kahraman can kaybı = saldırgan kayıp yüzdesi (− zırh). Resmî kaynak yalnızca "dost birlik kayıp yüzdesinden tahmin edilebilir" der.</li>
      <li><b>Tahmin:</b> yolculuk süreleri, boş vahada yağmalanabilir oran (%100 varsayılır, değiştirilebilir), hayvan yenilenmesi (hesaplanmaz).</li>
    </ul></section>`;
}

// ---------- Çizim ----------
const TABS = [['oasis', 'Vaha', tabOasis], ['sim', 'Simülatör', tabSim], ['rainbow', 'Rainbow', tabRainbow], ['profile', 'Profil', tabProfile], ['settings', 'Ayarlar', tabSettings]];
function render() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${T.tab === k ? 'on' : ''}" ${T.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('');
  $('#main').innerHTML = TABS.find((t) => t[0] === T.tab)[2]();
}
const rerenderResults = () => { const el = $('#results'); if (el) el.innerHTML = renderResults(); };

// ---------- Eylemler ----------
let worker = null, jobId = 0;
function runOptimize() {
  if (T.busy) return;
  const hm = S.prefs.heroMode;
  const base = baseConfig(OPT_UNIT_IDS, S.prefs.attackMode);
  const hero = hm === 'none' ? null : heroCfg();
  const max = OPT_UNIT_IDS.map((id) => int(S.profile.troops[id]));
  const prefs = prefsCfg();
  if (hm !== 'alone' && max.every((v) => v === 0) && !hero) { T.result = { error: 'Kullanılabilir asker yok. Profil sekmesinden asker sayılarını girin.' }; rerenderResults(); return; }
  T.busy = true; T.progress = 0; render();
  const done = (res) => {
    T.busy = false; T.result = { ...res, heroMode: hm };
    const opt = hm === 'with' ? res.withHero : res.noHero;
    const pick = hm === 'alone' ? null : opt.picks[S.prefs.pickMode] || opt.picks.balanced;
    const rep = hm === 'alone' ? res.heroAlone : pick ? repFor(pick.counts, hm === 'with') : null;
    if (rep) {
      S.history.unshift({ t: Date.now(), oasis: (coordsOk(S.oasis.coords) ? `(${S.oasis.coords.x}|${S.oasis.coords.y}) ` : '') + rep.animals.map((a) => `${a.count} ${a.tr}`).join(', '), army: OPT_UNIT_IDS.map((id) => (rep.units.find((u) => u.id === id) || { sent: 0 }).sent).join('/') + (rep.hero ? ' + kahraman' : ''), net: rep.net, ratio: rep.lossRatio });
      S.history.length = Math.min(S.history.length, 50); persist();
    }
    render();
    const el = $('#results'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const fail = (msg) => { T.busy = false; T.result = { error: msg }; render(); };
  const sync = () => setTimeout(() => { try { done(compareHeroModes(base, hero, max, prefs)); } catch (e) { fail(String(e.message || e)); } }, 30);
  try {
    if (!worker) worker = new Worker(new URL('../optimizer/worker.js', import.meta.url), { type: 'module' });
    const id = ++jobId;
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progress != null) { T.progress = e.data.progress; const b = document.querySelector('[data-act="optimize"]'); if (b) b.textContent = `Hesaplanıyor… ${Math.round(T.progress * 100)}%`; return; }
      if (e.data.error) fail(e.data.error); else done(e.data.result);
    };
    worker.onerror = () => { worker = null; sync(); };
    worker.postMessage({ id, baseConfig: base, heroCfg: hero, max, prefs });
  } catch { worker = null; sync(); }
}
function runSim() {
  const cfg = baseConfig(ALL_HUN_IDS, S.sim.mode);
  cfg.hero = S.prefs.heroMode === 'none' ? null : heroCfg();
  T.simReport = createScenario(cfg).report(ALL_HUN_IDS.map((id) => int(S.sim.units[id])));
  if (T.simReport.valid) T.lastReport = T.simReport;
  render();
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let data = c.toDataURL('image/png'), mediaType = 'image/png';
      if (data.length > 2_500_000) { data = c.toDataURL('image/jpeg', 0.9); mediaType = 'image/jpeg'; }
      resolve({ url, img, base64: data.split(',')[1], mediaType });
    };
    img.onerror = () => reject(new Error('Görüntü açılamadı.'));
    img.src = url;
  });
}
function applyRecognition(out, source) {
  if (out.empty) { T.visionMsg = { cls: 'bad', html: `${source}: görüntüde hayvan tanınamadı. Mevcut değerler değiştirilmedi; elle girebilirsiniz.${out.warnings.length ? '<br>' + out.warnings.map(esc).join('<br>') : ''}` }; return; }
  S.oasis.animals = {}; S.oasis.conf = {};
  for (const a of out.animals) { S.oasis.animals[a.id] = a.count; S.oasis.conf[a.id] = { confidence: a.confidence, note: a.note }; }
  if (out.coords) S.oasis.coords = { x: out.coords.x, y: out.coords.y };
  if (out.oasisType && OASIS_TYPES[out.oasisType]) S.oasis.type = out.oasisType;
  const low = out.animals.filter((a) => a.confidence === 'low');
  T.visionMsg = { cls: low.length || out.warnings.length ? 'warn' : 'ok', html: `${source}: ${out.animals.map((a) => `<b>${a.count}</b> ${ANIMALS[a.id].tr}`).join(', ')}${out.coords ? ` · koordinat (${out.coords.x}|${out.coords.y})` : ''}. ${low.length ? `<b>${low.length} değer emin değil</b> — aşağıda ⚠ ile işaretli, lütfen kontrol edin.` : 'Lütfen sayıları görüntüyle karşılaştırın.'}${out.warnings.length ? '<br>' + out.warnings.map(esc).join('<br>') : ''}` };
  T.result = null; persist();
}
async function visionAI(kind) {
  if (!S.vision.consent || !S.vision.apiKey) { T.visionMsg = { cls: 'warn', html: 'Yapay zekâ tanıma haricî bir servistir. Kullanmak için <b>Ayarlar → Görüntü tanıma</b> bölümünden izin verip API anahtarınızı girin. Cihazda OCR veya elle giriş anahtarsız çalışır.' }; if (kind === 'hero') toast('Önce Ayarlar → Görüntü tanıma bölümünden izin ve anahtar girin.'); render(); return; }
  const im = kind === 'hero' ? T.heroImage : T.image;
  T.visionBusy = true; render();
  try {
    const out = await recognizeWithClaude({ apiKey: S.vision.apiKey, model: S.vision.model, imageBase64: im.base64, mediaType: im.mediaType, kind });
    if (kind === 'hero') {
      const got = [];
      for (const [k, l] of [['strength', 'savaş gücü'], ['health', 'sağlık'], ['level', 'seviye'], ['offBonusPct', 'saldırı bonusu']]) if (out[k] != null) { S.profile.hero[k] = out[k]; got.push(`${l} ${out[k]}`); }
      if (out.notes) S.profile.hero.notes = out.notes;
      persist(); toast(got.length ? 'Okundu: ' + got.join(', ') + '. Kontrol edin.' : 'Kahraman bilgisi okunamadı; elle girin.');
    } else applyRecognition(out, 'Yapay zekâ');
  } catch (e) {
    const msg = e instanceof TypeError ? 'Bağlantı kurulamadı (internet yok veya istek engellendi).' : String(e.message || e);
    if (kind === 'hero') toast(msg); else T.visionMsg = { cls: 'bad', html: esc(msg) + ' Elle giriş her zaman kullanılabilir.' };
  }
  T.visionBusy = false; render();
}
async function visionOcr() {
  T.visionBusy = true; render();
  try { applyRecognition(await recognizeWithOcr(T.image.img), 'Cihazda OCR'); }
  catch (e) { T.visionMsg = { cls: 'bad', html: esc(String(e.message || e)) + ' Elle giriş her zaman kullanılabilir.' }; }
  T.visionBusy = false; render();
}

const ACTIONS = {
  inc: (id) => { S.oasis.animals[id] = int(S.oasis.animals[id]) + 1; delete S.oasis.conf[id]; T.result = null; },
  dec: (id) => { S.oasis.animals[id] = Math.max(0, int(S.oasis.animals[id]) - 1); delete S.oasis.conf[id]; T.result = null; },
  'clear-animals': () => { S.oasis.animals = {}; S.oasis.conf = {}; T.result = null; T.visionMsg = null; },
  'hero-mode': (id) => { S.prefs.heroMode = id; T.result = null; T.simReport = null; },
  'attack-mode': (id) => { S.prefs.attackMode = id; T.result = null; },
  'sim-mode': (id) => { S.sim.mode = id; T.simReport = null; },
  'pick-mode': (id) => { S.prefs.pickMode = id; },
  optimize: () => { persist(); runOptimize(); return false; },
  simulate: () => { persist(); runSim(); return false; },
  'sim-from-rec': () => { S.sim.units = {}; for (const u of T.lastReport.units) S.sim.units[u.id] = u.sent; S.sim.mode = T.lastReport.mode; T.simReport = null; },
  'vision-ai': () => { visionAI('oasis'); return false; },
  'vision-ocr': () => { visionOcr(); return false; },
  'parse-text': () => { const t = $('#paste-text').value; const out = parseAnimalText(t); out.coords = parseCoords(t); applyRecognition(out, 'Metin'); },
  'estimate-stock': () => { S.oasis.stock = estimateOasisStock(OASIS_TYPES[S.oasis.type], num(S.profile.serverSpeed, 1), num(S.oasis.hours)); T.result = null; toast('Tahmin: üretim × sunucu hızı × saat (depo sınırıyla). Gerçek miktar farklı olabilir.'); },
  'save-oasis': () => {
    const entry = { coords: { ...S.oasis.coords }, type: S.oasis.type, animals: { ...S.oasis.animals }, stock: [...S.oasis.stock], savedAt: Date.now() };
    const i = coordsOk(entry.coords) ? S.oases.findIndex((o) => String(o.coords.x) === String(entry.coords.x) && String(o.coords.y) === String(entry.coords.y)) : -1;
    if (i >= 0) S.oases[i] = entry; else S.oases.push(entry);
    toast(i >= 0 ? 'Vaha güncellendi.' : 'Vaha listeye kaydedildi (Rainbow sekmesi).');
  },
  'load-oasis': (id) => { const o = S.oases[+id]; if (!o) return; S.oasis = { ...S.oasis, coords: { ...o.coords }, type: o.type, animals: { ...o.animals }, stock: [...o.stock], conf: {} }; T.result = null; T.tab = 'oasis'; },
  'del-oasis': (id) => { S.oases.splice(+id, 1); },
  'save-ref': () => {
    const rep = T.simReport; if (!rep) return;
    const lost = {}, killed = {};
    document.querySelectorAll('[data-ref-lost]').forEach((el) => { lost[el.dataset.refLost] = int(el.value); });
    document.querySelectorAll('[data-ref-killed]').forEach((el) => { killed[el.dataset.refKilled] = int(el.value); });
    const ref = { id: 'u' + Date.now(), name: $('#ref-name').value.trim() || `${rep.units.map((u) => u.sent + ' ' + u.tr).join(', ')} — ${new Date().toLocaleDateString('tr-TR')}`, source: 'Kullanıcı', mode: rep.mode,
      units: Object.fromEntries(rep.units.map((u) => [u.id, u.sent])), animals: Object.fromEntries(rep.animals.map((a) => [a.id, a.count])), expected: { lost, killed } };
    S.refs.push(ref); const c = checkReference(ref);
    toast(c.ok ? 'Kaydedildi: motor oyun sonucuyla birebir eşleşiyor.' : 'Kaydedildi — UYUŞMAZLIK: ' + c.mismatches.join('; '));
  },
  'del-ref': (id) => { S.refs.splice(+id, 1); },
  'clear-history': () => { S.history = []; },
  export: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...S, vision: { ...S.vision, apiKey: '' } }, null, 2)], { type: 'application/json' })); a.download = 'hun-oasis-tool.json'; a.click(); toast('Dışa aktarıldı (API anahtarı dahil edilmedi).'); return false; },
  reset: () => { if (!confirm('Bütün kayıtlı veriler (profil, vahalar, geçmiş, referanslar, API anahtarı) silinsin mi? Bu işlem geri alınamaz.')) return false; S = DEFAULT_STATE(); T.result = T.simReport = T.lastReport = null; },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { T.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = ACTIONS[b.dataset.act];
  if (!fn) return;
  if (b.tagName === 'BUTTON' && b.closest('summary')) e.preventDefault();
  if (fn(b.dataset.id) !== false) { persist(); render(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'img-oasis' && el.files[0]) { try { T.image = await loadImage(el.files[0]); T.visionMsg = null; } catch (err) { toast(err.message); } render(); return; }
  if (el.id === 'img-hero' && el.files[0]) { try { T.heroImage = await loadImage(el.files[0]); await visionAI('hero'); } catch (err) { toast(err.message); } return; }
  if (el.id === 'import-file' && el.files[0]) { try { const key = S.vision.apiKey; S = importState(await el.files[0].text()); if (!S.vision.apiKey) S.vision.apiKey = key; persist(); toast('İçe aktarıldı.'); } catch { toast('Dosya okunamadı: geçerli bir dışa aktarım değil.'); } render(); return; }
  if (el.dataset.animal) { S.oasis.animals[el.dataset.animal] = int(el.value); delete S.oasis.conf[el.dataset.animal]; T.result = null; persist(); render(); return; }
  if (el.dataset.bind) {
    const v = el.type === 'checkbox' ? el.checked : el.dataset.raw != null || el.tagName === 'SELECT' ? el.value : el.value === '' ? 0 : num(el.value);
    setPath(el.dataset.bind, v); persist();
    if (!el.dataset.bind.startsWith('vision.') && !el.dataset.bind.startsWith('profile.hero.notes')) { T.result = null; T.simReport = T.tab === 'sim' ? null : T.simReport; }
    if (el.dataset.rerender != null || el.type === 'checkbox' || el.tagName === 'SELECT' || T.tab === 'oasis' || T.tab === 'rainbow') render();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });

render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
window.__app = { get state() { return S; }, T, getPath };
