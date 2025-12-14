# Drogéria Domov - Chatbot

Konverzačný AI asistent pre e-shop drogeriadomov.sk. Používa BM25 vyhľadávanie a DeepSeek AI pre inteligentné odporúčania produktov.

## Architektúra

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (index.html)                     │
│  - Chat UI s quick replies                                       │
│  - História konverzácie                                          │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Vercel Serverless API                         │
│                                                                  │
│  /api/chat.js          - Konverzačný AI s BM25 vyhľadávaním     │
│  /api/syncXML.js       - Synchronizácia produktov z XML         │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
        ┌──────────────────┐              ┌──────────────────┐
        │  Upstash Redis   │              │   DeepSeek AI    │
        │  - Produkty      │              │   (deepseek-chat)│
        │  - BM25 indexy   │              └──────────────────┘
        │  - Kategórie     │
        └──────────────────┘
```

## Funkcie

### BM25 Vyhľadávanie
- Optimalizované pre slovenčinu (normalizácia diakritiky)
- Invertovaný index pre rýchle vyhľadávanie
- Relevantné výsledky zoradené podľa skóre

### Konverzačný AI
- **Poradenstvo** - AI sa pýta na spresnenie požiadaviek
- **Odporúčania** - Max 3-5 produktov, nie celé zoznamy
- **Dialóg** - Pamätá si kontext konverzácie

## Inštalácia

```bash
npm install
cp .env.example .env
# Vyplňte hodnoty v .env
```

## Konfigurácia (.env)

```env
XML_URL=https://www.drogeriadomov.sk/export/products.xml
KV_REST_API_URL=https://your-redis.upstash.io
KV_REST_API_TOKEN=your_token_here
DEEPSEEK_API_KEY=your-deepseek-api-key
```

## Spustenie

```bash
# Lokálny vývoj
npm run dev

# Manuálny sync produktov
curl -X POST http://localhost:3000/api/syncXML
```

## API Endpoints

### POST /api/chat
```json
{
  "message": "Hľadám šampón",
  "history": []
}
```

### GET/POST /api/syncXML
Synchronizácia produktov z XML feedu.

## Cron Job

Automatická synchronizácia denne o 6:00 UTC.
