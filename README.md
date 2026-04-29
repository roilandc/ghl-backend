# GHL Bot Builder - Backend

## Setup

1. Clone/download this folder
2. Run: `npm install`
3. Copy `.env.example` to `.env` and fill in your values:
   - `GHL_PRIVATE_TOKEN` → GHL Dashboard → Settings → Integrations → Private Integrations
   - `GHL_LOCATION_ID` → Found in your GHL URL or API settings

## Run locally
```bash
npm run dev
```

## Deploy (Render.com - free)
1. Push to GitHub
2. Create new Web Service on Render
3. Add environment variables from .env
4. Deploy

## API

### POST /setup-bots
Triggers knowledge base creation, crawl, and training for both chat and voice bots.

**Request body:**
```json
{
  "businessName": "Acme Corp",
  "url": "https://acmecorp.com"
}
```

**Response:**
```json
{
  "success": true,
  "chatBot": { "kbId": "abc123", "type": "Chat" },
  "voiceBot": { "kbId": "def456", "type": "Voice" }
}
```

## Connecting to GHL Frontend
In your GHL AI Studio form, on submit send a POST request to:
```
https://your-deployed-url.onrender.com/setup-bots
```
With the businessName and url fields from the form.
