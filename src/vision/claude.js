// Yapay zekâ ile ekran görüntüsü tanıma (isteğe bağlı, HARİCÎ servis).
// Görüntü, kullanıcının kendi API anahtarıyla doğrudan tarayıcıdan Anthropic API'sine gönderilir.
// Anahtar yalnızca bu cihazın yerel deposunda tutulur. Savaş motorundan tamamen bağımsızdır.
// Derleme adımı olmayan, bağımlılıksız bir PWA olduğu için SDK yerine ham fetch kullanılır.
import { ANIMAL_IDS } from '../data/nature.js';
import { normalizeRecognition, normalizeHero } from './parse.js';

export const VISION_MODELS = [
  { id: 'claude-opus-5-5', tr: 'Claude Opus 5.5 (varsayılan, en doğru)' },
  { id: 'claude-sonnet-5-5', tr: 'Claude Sonnet 5.5 (daha ucuz)' },
  { id: 'claude-haiku-5-5', tr: 'Claude Haiku 5.5 (en ucuz)' },
];

const OASIS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['animals', 'coords', 'oasisType', 'notes'],
  properties: {
    animals: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'count', 'confidence', 'note'],
        properties: {
          id: { type: 'string', enum: ANIMAL_IDS }, count: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'low'] }, note: { type: 'string' },
        },
      },
    },
    coords: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'integer' }, y: { type: 'integer' } } }] },
    oasisType: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['iron25', 'iron25crop', 'iron50', 'clay25', 'clay25crop', 'clay50', 'wood25', 'wood25crop', 'wood50', 'crop25', 'crop50'] }] },
    notes: { type: 'string' },
  },
};
const HERO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['strength', 'health', 'level', 'offBonusPct', 'notes'],
  properties: {
    strength: { anyOf: [{ type: 'null' }, { type: 'number' }] }, health: { anyOf: [{ type: 'null' }, { type: 'number' }] },
    level: { anyOf: [{ type: 'null' }, { type: 'number' }] }, offBonusPct: { anyOf: [{ type: 'null' }, { type: 'number' }] },
    notes: { type: 'string' },
  },
};

const OASIS_PROMPT = `Bu, Travian: Legends oyununda bir vaha (oasis) penceresinin ekran görüntüsü.
Görevin: "Birlikler / Troops" bölümünde görünen doğa hayvanlarını ve sayılarını oku.
Hayvan kimlikleri: rat (sıçan), spider (örümcek), snake (yılan), bat (yarasa), boar (yaban domuzu), wolf (kurt), bear (ayı), crocodile (timsah), tiger (kaplan), elephant (fil).
Kurallar:
- Yalnızca görüntüde GERÇEKTEN görünen hayvanları listele. Görünmeyen hayvanı asla ekleme, tahmin etme.
- Her sayıyı yanındaki ikon/ad ile eşleştir. İkonu veya sayıyı net okuyamıyorsan confidence "low" yaz ve note alanında nedenini kısaca belirt; net ise "high".
- Koordinat (x|y) görünüyorsa coords alanına yaz, görünmüyorsa null.
- Vaha bonusu görünüyorsa (ör. "%25 Demir", "%25 Kil ve %25 Tahıl") oasisType alanını doldur, emin değilsen null.
- Hayvan görünmüyorsa animals boş dizi olsun. notes alanına görüntüyle ilgili kısa bir uyarı yazabilirsin (yoksa boş bırak).`;

const HERO_PROMPT = `Bu, Travian: Legends oyununda kahraman (hero) özellik ekranının görüntüsü.
Şunları oku: strength = "Savaş gücü / Fighting strength" toplam değeri (ör. 1.460 → 1460), health = sağlık yüzdesi (ör. %65 → 65),
level = kahraman seviyesi, offBonusPct = "Saldırı bonusu / Offence bonus" yüzdesi (ör. %4 → 4).
Görüntüde net görünmeyen her alan için null döndür; asla tahmin etme. notes: görünen ekipman/bonuslar hakkında kısa not.`;

async function call(apiKey, body, useFallback) {
  const headers = {
    'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = { ...body };
  if (useFallback) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; payload.fallbacks = 'default'; }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(payload) });
  let json = null;
  try { json = await res.json(); } catch { /* gövde yok */ }
  return { res, json };
}

/**
 * @param kind 'oasis' | 'hero'
 * @returns oasis: normalizeRecognition çıktısı; hero: normalizeHero çıktısı
 */
export async function recognizeWithClaude({ apiKey, model, imageBase64, mediaType, kind = 'oasis' }) {
  if (!apiKey) throw new Error('API anahtarı girilmemiş (Ayarlar → Görüntü tanıma).');
  const body = {
    model: model || 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: kind === 'hero' ? HERO_SCHEMA : OASIS_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: kind === 'hero' ? HERO_PROMPT : OASIS_PROMPT },
      ],
    }],
  };
  // Opus/Sonnet 5.5'te sunucu taraflı ret-yedeği varsayılan olarak açılır; desteklenmezse onsuz yeniden denenir.
  const fallbackCapable = /opus-5-5|sonnet-5-5/.test(body.model);
  let { res, json } = await call(apiKey, body, fallbackCapable);
  if (res.status === 400 && fallbackCapable) ({ res, json } = await call(apiKey, body, false));
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || res.statusText;
    if (res.status === 401) throw new Error('API anahtarı geçersiz (401).');
    if (res.status === 429) throw new Error('İstek sınırı aşıldı (429). Biraz sonra yeniden deneyin.');
    if (res.status >= 500) throw new Error('Servis geçici olarak kullanılamıyor (' + res.status + ').');
    throw new Error('Tanıma isteği başarısız (' + res.status + '): ' + msg);
  }
  if (json.stop_reason === 'refusal') throw new Error('Model bu görüntüyü işlemeyi reddetti. Elle giriş yapın.');
  if (json.stop_reason === 'max_tokens') throw new Error('Yanıt yarıda kesildi. Yeniden deneyin veya elle girin.');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Model yanıtı ayrıştırılamadı. Elle giriş yapın.'); }
  if (kind === 'hero') return normalizeHero(parsed);
  const out = normalizeRecognition(parsed);
  if (parsed.notes) out.warnings.push('Model notu: ' + String(parsed.notes).slice(0, 200));
  return out;
}
