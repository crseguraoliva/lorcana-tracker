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
  try {
    const parts = cardName.split(" - ");
    const name = encodeURIComponent(parts[0]);
    const setId = Object.entries({
      "The First Chapter":"1","Rise of the Floodborn":"2",
      "Into the Inklands":"3","Ursula's Return":"4",
      "Ursula Return":"4","Shimmering Skies":"5",
      "Azurite Sea":"6","Archazias Island":"7","Archazia's Island":"7",
      "Reign of Jafar":"8","Fabled":"9","Whispers in the Well":"10",
      "Winterspell":"11","Wilds Unknown":"12"
    }).find(([k]) => setName.includes(k))?.[1] || "";

    const r = await fetch(`https://api.lorcast.com/v0/cards/search?q=${name}+rarity:enchanted+set:${setId}&unique=prints`);
    const data = await r.json();

    if (!data.results?.length) return { success: false };

    const card = data.results.find(c =>
      c.rarity === "Enchanted" &&
      (parseInt(c.set?.code) === parseInt(setId) || !setId)
    ) || data.results.find(c => c.rarity === "Enchanted") || data.results[0];

    const tcgplayer_nm = card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null;
    const avg_price = tcgplayer_nm;

    return {
      success: true,
      tcgplayer_nm,
      ebay_nm_avg: null,
      ebay_sold_prices: [],
      lowest_nm_available: tcgplayer_nm,
      total_nm_listings: null,
      psa9_price: null,
      psa10_price: null,
      avg_price,
      image_url: card.image_uris?.digital?.normal || null,
      tcgplayer_id: card.tcgplayer_id || null,
    };
  } catch(e) {
    console.error(`Error fetching ${cardName}:`, e.message);
    return { success: false };
  }
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

 refreshProgress = { current: refreshProgress.total, total: refreshProgress.total, card: "Complete!", running: false, done: true };
refreshInProgress = false;
console.log("Full refresh complete!");
}

cron.schedule("0 */6 * * *", () => {
  console.log("Auto-refresh triggered");
  runFullRefresh();
});

const path = require("path");
app.use(express.static(path.join(__dirname, ".")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

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
// Fetch and cache card images from Lorcast
app.get("/api/sync-images", async (req, res) => {
  try {
    let allCards = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const r = await fetch(`https://api.lorcast.com/v0/cards/search?q=rarity:enchanted+lang:en&unique=prints&page=${page}`);
      const data = await r.json();
      if (data.results?.length) {
        allCards = allCards.concat(data.results);
        hasMore = data.has_more || false;
        page++;
      } else { hasMore = false; }
    }

    // Update cards table with image URLs
    for (const card of allCards) {
      const imgUrl = card.image_uris?.digital?.normal || null;
      const cardNum = parseInt(card.collector_number);
      const setNum = card.set?.code ? parseInt(card.set.code.replace(/\D/g,'')) : null;
      
      if (imgUrl && cardNum && setNum) {
        await supabase.from("cards")
          .update({ image_url: imgUrl })
          .eq("set_id", setNum)
          .like("id", `${setNum}-%`)
          .gte("id", `${setNum}-1`)
          .lte("id", `${setNum}-99`);
      }
    }
    res.json({ success: true, synced: allCards.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => console.log(`Lorcana Tracker API running on port ${PORT}`));
