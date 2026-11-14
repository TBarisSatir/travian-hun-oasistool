// Cihaz üzerinde metin OCR (deneysel). Görüntü cihazdan ÇIKMAZ; ancak Tesseract.js kitaplığı ve
// dil verisi ilk kullanımda jsDelivr CDN'inden indirilir. Yalnızca hayvan ADLARI ve sayıları
// görüntüde yazı olarak görünüyorsa çalışır (Travian vaha penceresi "3 Sıçan" biçiminde listeler);
// ikon tanımaz. İkon tanıma için yapay zekâ yöntemi kullanılır.
import { parseAnimalText, parseCoords } from './parse.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;

function loadTesseract() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = () => resolve(globalThis.Tesseract);
      s.onerror = () => { loading = null; reject(new Error('OCR kitaplığı indirilemedi (internet gerekli).')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** Küçük yazıları okutmak için görüntüyü büyütüp gri tonlamaya çevirir. */
function preprocess(img) {
  const scale = Math.max(1, Math.min(3, 1800 / Math.max(img.width, 1)));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.4)';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export async function recognizeWithOcr(img, onProgress) {
  const T = await loadTesseract();
  const { data } = await T.recognize(preprocess(img), 'tur+eng', {
    logger: (m) => { if (onProgress && m.status === 'recognizing text') onProgress(m.progress); },
  });
  const text = data.text || '';
  const out = parseAnimalText(text);
  out.coords = parseCoords(text);
  // OCR sayıları yanlış okuyabilir: hiçbir sonuç "yüksek güven" sayılmaz, kullanıcı kontrol etmelidir.
  out.animals.forEach((a) => { a.confidence = 'low'; a.note = a.note || 'OCR — sayıyı kontrol edin'; });
  out.rawText = text;
  if (out.empty) out.warnings.push('Görüntüde hayvan adı okunamadı. Yapay zekâ tanımayı deneyin veya elle girin.');
  return out;
}
