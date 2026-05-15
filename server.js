require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const cron = require("node-cron");

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function fetchCardPrices(cardName, setName) {
  const prompt = `Search for current Disney Lorcana Enchanted card prices for: "${cardName}" from "${setName}".
Search TCGPlayer NM Holofoil, eBay sold listings NM, and PSA graded eBay sales.
Return ONLY valid JSON, no markdown:
{
  "tcgplayer_nm": <number or null>,
  "ebay_nm_avg": <number or null>,
  "ebay_sold_prices": [<up to 5 numbers>],
  "lowest_nm_available": <number or null>,
  "total_nm_listings": <number or null>,
  "psa9_price": <number or null>,
  "psa10_price": <number or null>,
  "listings": [{"price": <number>, "seller": "<string>"}]
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const p = JSON.parse(match[0]);
      const vals = [p.tcgplayer_nm, p.ebay_nm_avg].filter(Boolean);
      p.avg_price = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return { ...p, success: true };
    }
  } catch (e) {
    console.error(`Error fetching ${cardName}:`, e.message);
  }
  return { success: false };
}

async function saveSnapshot(cardId, result) {
  const today = new Date().toISOString().split("T")[0];
  const snap = {
    card_id: cardId,
    snapshot_date: today,
    tcgplayer_nm: result.tcgplayer_nm || null,
    ebay_nm_avg: result.ebay_nm_avg || null,
    ebay_sold_1: result.ebay_sold_prices?.[0] || null,
    ebay_sold_2: result.ebay_sold_prices?.[1] || null,
    ebay_sold_3: result.ebay_sold_prices?.[2] || null,
    ebay_sold_4: result.ebay_sold_prices?.[3] || null,
    ebay_sold_5: result.ebay_sold_prices?.[4] || null,
    lowest_nm_available: result.lowest_nm_available || null,
    total_nm_listings: result.total_nm_listings || null,
    psa9_price: result.psa9_price || null,
    psa10_price: result.psa10_price || null,
    avg_price: result.avg_price || null,
    fetched_at: new Date().toISOString(),
  };

  await supabase.from("price_snapshots").insert(snap);

  if (result.avg_price && result.lowest_nm_available) {
    const diff = (result.lowest_nm_available - result.avg_price) / result.avg_price;
    if (diff < -0.1) {
      await supabase.from("opportunities").insert({
        card_id: cardId,
        avg_market_price: result.avg_price,
        lowest_available: result.lowest_nm_available,
        discount_pct: diff * 100,
        signal: diff < -0.2 ? "STRONG BUY" : "BUY",
        detected_at: new Date().toISOString(),
      });
    }
  }

  return snap;
}

let refreshInProgress = false;
let refreshProgress = { current: 0, total: 0, card: "", running: false };

async function runFullRefresh() {
  if (refreshInProgress) return;
  refreshInProgress = true;

  const { data: cards } = await supabase.from("cards").select("*").order("set_id").order("id");
  if (!cards?.length) { refreshInProgress = false; return; }

  refreshProgress = { current: 0, total: cards.length, card: "", running: true };
  console.log(`Starting full refresh of ${cards.length} cards...`);

  for (const card of cards) {
    refreshProgress.current++;
    refreshProgress.card = card.card_name;
    console.log(`[${refreshProgress.current}/${refreshProgress.total}] ${card.card_name}`);

    const result = await fetchCardPrices(card.card_name, card.set_name);
    if (result.success) await saveSnapshot(card.id, result);

    await new Promise(r => setTimeout(r, 800));
  }

  refreshProgress = { current: 0, total: 0, card: "", running: false };
  refreshInProgress = false;
  console.log("Full refresh complete!");
}

cron.schedule("0 */6 * * *", () => {
  console.log("Auto-refresh triggered");
  runFullRefresh();
});

app.get("/", (req, res) => res.json({ status: "ok", message: "Lorcana Tracker API" }));

app.get("/api/cards", async (req, res) => {
  const { data, error } = await supabase.from("cards").select("*").order("set_id").order("id");
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get("/api/prices", async (req, res) => {
  const { data, error } = await supabase
    .from("price_snapshots")
    .select("*")
    .order("fetched_at", { ascending: false });
  if (error) return res.status(500).json({ error });

  const latest = {};
  (data || []).forEach(s => { if (!latest[s.card_id]) latest[s.card_id] = s; });
  res.json(Object.values(latest));
});

app.get("/api/prices/:cardId/history", async (req, res) => {
  const { data, error } = await supabase
    .from("price_snapshots")
    .select("*")
    .eq("card_id", req.params.cardId)
    .order("fetched_at", { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get("/api/collection", async (req, res) => {
  const { data, error } = await supabase.from("collection").select("*");
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post("/api/collection", async (req, res) => {
  const { card_id, owned, paid_price, notes } = req.body;
  const { data, error } = await supabase
    .from("collection")
    .upsert({ card_id, owned, paid_price, notes, updated_at: new Date().toISOString() })
    .select();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get("/api/opportunities", async (req, res) => {
  const { data, error } = await supabase
    .from("opportunities")
    .select("*, cards(card_name, set_name, set_id)")
    .order("detected_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post("/api/refresh/card/:cardId", async (req, res) => {
  const { data: card } = await supabase.from("cards").select("*").eq("id", req.params.cardId).single();
  if (!card) return res.status(404).json({ error: "Card not found" });

  const result = await fetchCardPrices(card.card_name, card.set_name);
  if (result.success) {
    const snap = await saveSnapshot(card.id, result);
    return res.json({ success: true, snapshot: snap });
  }
  res.json({ success: false });
});

app.post("/api/refresh/all", async (req, res) => {
  if (refreshInProgress) {
    return res.json({ success: false, message: "Refresh already in progress", progress: refreshProgress });
  }
  runFullRefresh();
  res.json({ success: true, message: "Full refresh started" });
});

app.get("/api/refresh/progress", (req, res) => {
  res.json(refreshProgress);
});

app.get("/api/listings/:cardId", async (req, res) => {
  const { data, error } = await supabase
    .from("active_listings")
    .select("*")
    .eq("card_id", req.params.cardId)
    .order("price");
  if (error) return res.status(500).json({ error });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lorcana Tracker API running on port ${PORT}`));
