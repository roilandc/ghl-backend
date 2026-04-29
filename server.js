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

async function scrapeWebsite(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KnowledgeBot/1.0)" },
  });
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function buildPrompt(businessName, url, content) {
  return `You are an AI assistant for ${businessName}.
Answer questions about this business based only on the information below.
Be helpful, friendly, and accurate. If you don't know something, say so.

Business Website: ${url}

=== BUSINESS INFORMATION ===
${content}
=== END ===`;
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