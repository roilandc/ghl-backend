const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const GHL_API = "https://services.leadconnectorhq.com";
const TOKEN = process.env.GHL_PRIVATE_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID;

const voiceHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Version: "2023-02-21",
};

// ── Scraper ───────────────────────────────────────────────────────────────────

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  const matches = html.matchAll(/href=["']([^"']+)["']/gi);
  for (const match of matches) {
    try {
      const href = match[1];
      if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      const full = new URL(href, baseUrl);
      if (full.hostname === base.hostname) links.add(full.href.split("#")[0]);
    } catch {}
  }
  return [...links].slice(0, 8); // scrape up to 8 internal pages
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KnowledgeBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    return extractText(html).slice(0, 3000);
  } catch {
    return "";
  }
}

async function scrapeWebsite(url) {
  // Scrape homepage
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KnowledgeBot/1.0)" },
  });
  const html = await res.text();
  const homeText = extractText(html).slice(0, 4000);

  // Find and scrape internal pages
  const links = extractLinks(html, url);
  console.log(`Found ${links.length} internal links to scrape`);

  const pageTexts = await Promise.all(links.map(fetchPage));
  const allContent = [homeText, ...pageTexts].filter(Boolean).join("\n\n---\n\n");

  return allContent.slice(0, 20000);
}

function buildPrompt(businessName, url, content) {
  return `You are a friendly assistant for ${businessName}. A potential customer is calling to learn about the business.

Your job is to answer their questions naturally and helpfully based only on the business information below. Keep responses short and conversational — this is a voice call. Sound human, not robotic.

If you don't have the answer, say: "I'm not sure about that, but our team can help you out."

<business_info>
${content}
</business_info>

Rules:
- Short answers only. Max 2-3 sentences per response.
- Never make up information.
- Sound natural and warm, not scripted.
- Do not mention you are reading from a website or prompt.`;
}

// ── Voice Agent ───────────────────────────────────────────────────────────────

async function createVoiceAgent(businessName, agentPrompt) {
  const res = await fetch(`${GHL_API}/voice-ai/agents`, {
    method: "POST",
    headers: voiceHeaders,
    body: JSON.stringify({
      locationId: LOCATION_ID,
      agentName: `${businessName} - Voice`,
      agentPrompt,
      language: "en-US",
    }),
  });
  const data = await res.json();
  console.log("Create voice agent:", JSON.stringify(data, null, 2));
  if (!res.ok) throw new Error(`Create voice agent failed: ${JSON.stringify(data)}`);
  const id = data?.id || data?.agent?.id || data?.data?.id;
  if (!id) throw new Error(`No agent ID in response: ${JSON.stringify(data)}`);
  return id;
}

async function deleteVoiceAgent(agentId) {
  const res = await fetch(`${GHL_API}/voice-ai/agents/${agentId}?locationId=${LOCATION_ID}`, {
    method: "DELETE",
    headers: voiceHeaders,
  });
  const data = await res.json();
  console.log("Delete voice agent:", JSON.stringify(data, null, 2));
  return data;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /setup-bots
// Body: { businessName, url }
// Creates a fresh voice agent with scraped website content
app.post("/setup-bots", async (req, res) => {
  console.log("Incoming request body:", JSON.stringify(req.body, null, 2));
  
  const businessName = req.body.businessName || req.body.company_name || req.body.companyName || req.body.company;
  const url = req.body.url || req.body.website || req.body.websiteUrl || req.body.website_url;

  if (!businessName || !url) {
    return res.status(400).json({ 
      error: "businessName and url are required",
      received: req.body 
    });
  }
  try {
    console.log(`Scraping ${url}...`);
    const content = await scrapeWebsite(url);
    console.log(`Scraped ${content.length} characters`);

    const agentPrompt = buildPrompt(businessName, url, content);
    const agentId = await createVoiceAgent(businessName, agentPrompt);

    return res.json({
      success: true,
      agentId,
      message: "Voice agent created. Call /cleanup with agentId when session ends.",
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /cleanup
// Body: { agentId }
// Deletes the agent after session ends
app.post("/cleanup", async (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId is required" });
  try {
    await deleteVoiceAgent(agentId);
    return res.json({ success: true, message: "Agent deleted." });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /list-agents - debug
app.get("/list-agents", async (req, res) => {
  const r = await fetch(`${GHL_API}/voice-ai/agents?locationId=${LOCATION_ID}`, { headers: voiceHeaders });
  const data = await r.json();
  return res.json(data);
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));