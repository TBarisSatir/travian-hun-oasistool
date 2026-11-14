# Hun Vaha Aracı

Travian: Legends için vaha savaş simülatörü ve optimal Hun ordusu bulucu (Bozkır Atlısı / Nişancı / Yağmacı).
Bağımsız bir karar destek aracıdır: Travian hesabına giriş yapmaz, şifre istemez, saldırı göndermez.

Derleme adımı ve bağımlılık yoktur: düz HTML + ES modülleri. Veriler yalnızca cihazda (tarayıcı deposu) tutulur.

## Çalıştırma

```bash
npm start
```

Tarayıcıda `http://localhost:5173` adresini açın. (ES modülleri nedeniyle `index.html` dosyasını doğrudan
`file://` ile açmak çalışmaz; herhangi bir statik sunucu yeterlidir.)

### iPhone'da kullanma (PWA)

1. Depoyu GitHub Pages ile yayınlayın: **Settings → Pages → Deploy from a branch → `main` / root**.
2. iPhone Safari'de `https://<kullanıcı>.github.io/travian-hun-oasistool/` adresini açın.
3. **Paylaş → Ana Ekrana Ekle.** İlk açılıştan sonra internet olmadan da elle giriş, simülasyon ve optimizasyon çalışır.

## Testler

```bash
npm test
```

27 test (şartnamedeki 30 maddeyi kapsar). Node 20+ gerekir.

## Kullanım akışı

1. **Vaha** sekmesi: ekran görüntüsünü yükleyin → "Yapay zekâ ile tanı" veya "Cihazda OCR" → sayıları kontrol edin
   (ya da doğrudan elle girin / metin yapıştırın).
2. Kahraman katılımını seçin: Kahramansız / Kahramanla / Yalnız kahraman.
3. **En İyi Kadroyu Bul.** Önerilen ordu, savaş sonucu, ekonomik verimlilik, alternatif stratejiler ve Pareto listesi görünür.
4. **Simülatör**: istediğiniz kadroyu elle deneyin; gerçek oyun sonucunu referans vaka olarak kaydedin.
5. **Rainbow**: köy/vaha koordinatı, yolculuk süresi, saatlik kâr, kayıtlı vaha listesi.
6. **Profil / Ayarlar**: asker sayıları, demirci, kahraman, kayıp sınırı (%50), kâr eşiği (%90), ağırlıklar, API anahtarı.

## Mimari

| Dosya | Görev |
|---|---|
| `src/data/units.js`, `nature.js` | Hun birimleri, silahlar, 10 doğa birimi, vaha türleri |
| `src/engine/battle.js` | **Tek savaş motoru** (saldırı, savunma, kayıp, yuvarlama, kahraman, ekonomi) |
| `src/engine/travel.js` | Mesafe, yolculuk süresi, vaha stok tahmini |
| `src/optimizer/optimizer.js` | Eksiksiz tarama + baskınlık elemesi + Pareto; `worker.js` Web Worker sarmalayıcısı |
| `src/vision/` | `parse.js` (doğrulama, metin ayrıştırma), `claude.js` (yapay zekâ), `icons.js` (cihaz içi ikon + sayı tanıma) |
| `src/data/references.js` | Gerçek oyun sonuçları (referans vakalar) |
| `src/ui/` | Arayüz ve yerel kayıt |

Simülatör ve optimizasyon aynı `createScenario().evaluate()` fonksiyonunu kullanır; ikinci bir savaş hesabı yoktur.

## Savaş modeli

- Saldırı = Σ (demirci(taban) + silah bonusu) × adet + kahraman gücü, × bonuslar
- Savunma = hayvan savunmaları (saldırının piyade/süvari payına göre ağırlıklı) + 10 vaha taban savunması
- Yağma: `x = (kaybeden/kazanan)^K`, kazanan kaybı `x/(1+x)`, kaybeden kaybı `1 − x/(1+x)`
- Normal saldırı: kazanan kaybı `x`, kaybeden %100
- `K = 2·(1,8592 − N^0,015)`, [1,2578 – 1,5]; toplam birim ≤ 1000 iken 1,5
- Kayıplar **her birim türü için ayrı** yuvarlanır
- Hayvan ödülü = öldürülen tahıl tüketimi × 40 × 4 hammadde (kahraman heybesine; kahraman katılmasa da, ordu ölse de verilir)

## Doğrulama durumu

| Durum | Kapsam |
|---|---|
| **Doğrulandı** (iki gerçek oyun simülasyonu, birebir) | Yağma kayıp formülü, birim bazlı yuvarlama, +10 taban savunma, sıçan/örümcek/yarasa süvari savunması, hayvan ödülü |
| **Resmî kaynakla uyumlu** | 1/1/1 kadrosu 410 savunmaya kadar kayıpsız → tam 0,5 saldırgan lehine aşağı yuvarlanır |
| **Varsayım** | Hayvan kaybında tam 0,5 yukarı; demirci formülünde yuvarlama yok; büyük savaş üssünün yağmada da geçerli olması; diğer hayvanların savunma değerleri (üçüncü taraf tablo) |
| **Model tahmini** | Kahraman can kaybı = saldırgan kayıp yüzdesi (− zırh). Resmî formül yayımlanmamıştır; gerçek raporlarla kalibrasyon gerekir |
| **Tahmin** | Yolculuk süreleri (resmî formül yok), boş vahada yağmalanabilir oran, depo kapasitesinin sunucu hızıyla ölçeklenmesi |
| **Hesaplanmaz** | Hayvan yeniden doğma zamanı ve sayısı (resmî kaynaklarda yok) |

Arayüzde her sonuç **Doğrulanmış / Matematiksel tahmin / Dikkat–sınırda** etiketlerinden birini taşır; uydurma güven yüzdesi gösterilmez.

## Görüntü tanıma

- **Yapay zekâ (isteğe bağlı, haricî servis):** görüntü, sizin API anahtarınızla doğrudan tarayıcıdan Anthropic API'sine gönderilir.
  Açık izin ve anahtar gerekir (Ayarlar). Anahtar yalnızca cihazda saklanır ve dışa aktarıma dahil edilmez.
- **Cihazda tanı (ikon + sayı):** görüntü cihazdan çıkmaz; Tesseract.js ve dil verisi ilk kullanımda jsDelivr'den indirilir.
  Mobil vaha penceresindeki "Askerler" satırını bulur, her ikonu renk parmak iziyle eşleştirir, sayıyı rakam OCR'ı ile okur;
  koordinatı ve bonus satırından vaha türünü de çıkarır. Fil dışındaki dokuz hayvan yerleşik tanınır;
  fil (ve tanınmayan her ikon) ilk karşılaşmada bir kez seçilir ve cihazda öğrenilir. Tanınmayan ikon asla tahmin edilmez.
  "Askerler" satırı yoksa (ör. masaüstü düzeni) yazıyla görünen hayvan adlarını okumaya düşer.
- **Elle giriş / metin yapıştırma:** her zaman, internet olmadan çalışır.

Tanıma çıktısı her durumda doğrulanır: bilinmeyen hayvan eklenmez, okunamayan sayı sıfırlanıp işaretlenir.

## Bilinen sınırlar

- Yapay zekâ tanıma gerçek bir API anahtarıyla test edilmedi. Cihazda tanı beş gerçek mobil ekran görüntüsüyle
  (hepsi aynı telefon, 924×2000) doğrulandı: 18 hayvan satırı, 5 koordinat ve 5 vaha türü doğru okundu.
  Farklı çözünürlük, tema veya dilde ikon eşleşmesi tutmayabilir — o durumda ikon
  "tanınmadı" olarak gelir ve seçmeniz istenir. Sayıları her zaman görüntüyle karşılaştırın.
- Kahraman can kaybı doğrulanmamıştır; kahramanlı öneriler her zaman "Dikkat" olarak işaretlenir.
- Arama uzayı 6 milyon kombinasyonu aşarsa sınırlar küçültülür ve sonuç "sınırlı arama" olarak belirtilir.

## Kaynaklar

- support.travian.com: Battle mechanics (63), Combat simulator (18), Smithy (40), Oasis (48), Hero health (47),
  Hun hero items (97), 5 things about Huns (147), Oasis farming (185, 190), Tournament Square (71)
- unofficialtravian.com — Kirilloid: Combat basics; Smithy and total strength of an army
- siegewise.com — Hun ve Nature birim tabloları
