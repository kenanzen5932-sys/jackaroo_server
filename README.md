# 🎲 Jackaroo Online - Multiplayer WebSocket Game Server

TingleCHAT için 4 kişilik gerçek zamanlı Jackaroo Online oyun sunucusu.
Render.com üzerinde Node.js Web Service olarak çalıştırılmak üzere optimize edilmiştir.

---

## 📁 Klasör İçeriği
- `server.js`: WebSocket oyun mantığı, masa yönetimi, sıra motoru ve REST API'ler.
- `jackaroo_proto.js`: Lobi ve bağlantı Protobuf şemaları ve encode/decode modülleri.
- `jackaroo_game_proto.js`: Oyun içi kart, taş, hamle ve discard Protobuf modülleri.
- `protobuf.js`: Bağımsız Protobuf binary kütüphanesi (ekstra kuruluma gerek yok).
- `package.json`: Sunucu bağımlılıkları (`ws`).
- `render.yaml`: Render.com otomatik dağıtım konfigürasyonu.

---

## 🚀 1. Yerel Olarak Test Etme
```bash
# Bağımlılığı kurun
npm install

# Sunucuyu başlatın (varsayılan port 8088 veya PORT ortam değişkeni)
npm start
```
Tarayıcıdan `http://localhost:8088/` adresine girdiğinizde sunucu durumu JSON olarak dönecektir.

---

## 🐙 2. GitHub'a Yükleme (Render İçin)

Yeni bir GitHub reposu oluşturup bu klasörü aktarmak için:

```bash
# 1. jackaroo_server klasörüne geçin
cd c:/Users/burak/Desktop/chat/jackaroo_server

# 2. Git reposu başlatın
git init

# 3. Dosyaları ekleyip commit yapın
git add .
git commit -m "feat: initial jackaroo multiplayer websocket server"

# 4. GitHub'da oluşturduğunuz reponun linkini ekleyin
# (Örnek: https://github.com/KULLANICI_ADINIZ/jackaroo-server.git)
git remote add origin https://github.com/KULLANICI_ADINIZ/jackaroo-server.git

# 5. Kodu GitHub'a gönderin
git branch -M main
git push -u origin main
```

---

## 🌐 3. Render.com'da Yayına Alma

1. [Render.com Dashboard](https://dashboard.render.com/) adresine gidin.
2. **New +** -> **Web Service** seçin.
3. Az önce oluşturduğunuz GitHub reposunu (`jackaroo-server`) bağlayın.
4. Ayarları şu şekilde doldurun:
   - **Name**: `jackaroo-game-server` (veya istediğiniz bir isim)
   - **Region**: Frankfurt (EU Central) - *Türkiye'ye en yakın ve en düşük ping için*
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. **Create Web Service** butonuna tıklayın.
6. 1-2 dakika içinde sunucunuz hazır olacak! Render size şu şekilde bir URL verecektir:
   - `https://jackaroo-game-server.onrender.com`
   - WebSocket URL'niz: `wss://jackaroo-game-server.onrender.com`

---

## 🔗 4. API Endpoints
- `GET /` veya `GET /health` -> Sunucu durumu, aktif oyuncular ve masa bilgisi.
- `GET /api/invite_bot?id=...&name=...` -> Masaya bot veya oyuncu oturtma.
- `GET /api/reset_lobby` -> Masayı lobi durumuna sıfırlama.
