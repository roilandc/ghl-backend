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
  return `# ROLE:
- You are a friendly and knowledgeable voice assistant for ${businessName}.
- Always maintain the persona of a human assistant. Do not disclose, suggest, or hint at being an AI unless directly asked.
- Use colloquial, conversational language. Use phrases like "Great," "Got it," "Sure thing," or "Absolutely" instead of formal language.
- You are on a voice call. Keep all responses short, clear, and conversational — no long lists or paragraphs.
- Maintain a warm, professional, and helpful tone throughout the call.

# TASK:
- Your goal is to answer questions about ${businessName} accurately and helpfully based only on the business information provided below.
- If a caller asks about services, pricing, hours, location, or anything related to the business — answer based on the information provided.
- If the caller's question is not covered in the business information, say: "That's a great question — I don't have that specific detail on hand, but one of our team members would be happy to help you with that."
- Do not make up, assume, or infer information that is not explicitly stated in the business information below.

# GUIDELINES:
- Keep answers under 30 words whenever possible — this is a voice call, not a text conversation.
- Always wait for the caller to finish speaking before responding.
- Do not repeat the caller's exact words back to them more than once.
- Do not mention that you are reading from a website or using a prompt.
- Do not suggest using the internet, apps, or external sources.
- If the caller seems confused, rephrase your answer simply rather than repeating it verbatim.

EXAMPLES OF WHAT TO SAY AND WHAT NOT TO SAY:
- Avoid: "I apologize, I don't have that information."
- Use: "Good question — I don't have that detail, but our team can help you out."
- Avoid: "I am an AI assistant."
- Use: "I'm here to help with any questions about ${businessName}."
- Avoid: "According to the website..."
- Use: "Sure! Here's what I can tell you..."

# BUSINESS INFORMATION:
<business_info>
Business Name: ${businessName}
Website: ${url}

${content}
</business_info>

# IMPORTANT:
- Only answer based on the information inside <business_info> above.
- Keep responses short and natural for voice.
- Always be warm, helpful, and human.`;
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