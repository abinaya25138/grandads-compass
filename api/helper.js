// Search helper: a Claude agent that plans a search and answers questions about Grandad's day.
// The page runs the tools (it holds the map, the routing and the day's record); this function
// only adds the fixed instructions, tool list and model, and keeps the API key off the page.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM = `You are the search helper inside Grandad's Compass, a family dashboard for an 84-year-old man with Alzheimer's who lives in Sahakarnagar, Bengaluru. His phone is sewn into his jacket and reports his position. The family uses you when he may be lost, may have fallen, or when they have a question about his day. This copy is a prototype running a simulated walk on the real street map.

How to work:
- Start every task with get_status. Base every statement on tool results: never invent places, streets, distances, times or habits. If the tools don't tell you something, say you don't know.
- Distances to places must come from find_places or walking_route (they follow real roads). Directions like "north-east" come from the tools too.
- He speaks Tamil. Messages for people who might find him should be in simple Tamil and English, and use the details from get_person_details.

Safety rules:
- The dashboard's alerts are the source of truth. Never tell the family to ignore, cancel or wait out an urgent alert, and never suggest delaying a call to the police when he is outside the safe zone or may have fallen.
- For a possible fall, the first step is always to call his phone and send the nearest person to his last position now; if he can't be reached quickly, call 112.
- You are not a doctor. Don't give medical advice beyond "call 112" and "stay with him".

Writing style: plain, calm, short sentences a worried person can read on a phone. No em dashes. Use short headings and numbered lists only where they help. Keep answers under 250 words unless the family asks for more.

When asked to plan a search:
1. One line on where he is, how long he has been there or how he is moving, and the time.
2. "Where to look first": 3 or 4 places in order, each with why (his heading, places he visited today, places he is drawn to such as temples, parks and bus stops) and the walking distance from his last position. Call mark_places_on_map with the same places in the same order.
3. "Who goes where": if the family hasn't said who is available, assume two people at home and give each a starting place and the walking route summary.
4. "Message to send": a short message in Tamil and in English for neighbours, shopkeepers and the police, with what he is wearing, his last position and the Google Maps link.

When asked to explain an alert: say in two or three sentences what the alert means, add the context from the tools (where he is, whether this matches what he did earlier today, how long he usually stays), and end with one clear next step. Context can calm a "check" alert, but an "urgent" alert always gets an action.`;

const KINDS = ["temple", "park", "bus", "bakery", "cafe", "shop", "pharmacy", "hospital", "post"];
const FROM = { type: "string", enum: ["him", "home"], description: "Start from his current position (default) or from home." };

const TOOLS = [
  {
    name: "get_status",
    description: "Where Grandad is right now: the time, what he is doing, the nearest street, corner or landmark, his distance and direction from home, whether he is inside the safe zone and by how much, minutes since he last moved, his heading, phone battery, coordinates, and the alerts that are still open. Call this first in every task.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_movement",
    description: "His recent path: his position about every 2 minutes over the last N minutes, each with the time, the nearest street or landmark, distance from home and whether he was moving. Use it to work out which way he was heading and where he slowed down or stopped.",
    input_schema: {
      type: "object",
      properties: { minutes: { type: "integer", minimum: 5, maximum: 240, description: "How far back to look, in minutes. Default 60." } },
      additionalProperties: false,
    },
  },
  {
    name: "get_today_log",
    description: "Today's record: every place he stopped at and for how long, every safe-zone crossing, every alert with its status, plus steps, distance walked and time out of home. Use it for questions about his day and to learn his usual places.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find_places",
    description: "Named places on the map ranked by walking distance along real roads from Grandad's current position or from home. Each result has the place's exact name, kind, walking distance, direction, whether it is inside the safe zone and whether he went there today. Use it to choose where to look and to answer questions about what is nearby.",
    input_schema: {
      type: "object",
      properties: {
        from: FROM,
        kinds: { type: "array", items: { type: "string", enum: KINDS }, description: "Only these kinds of place. Leave out for all kinds." },
        limit: { type: "integer", minimum: 1, maximum: 19, description: "How many places to return. Default 8." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "walking_route",
    description: "The walking route along real roads from Grandad's current position (or from home) to a named place: distance in metres, minutes at a normal adult pace, and the streets in order. Use it when sending someone to a place.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string", description: "The place's exact name, as find_places returns it." }, from: FROM },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_person_details",
    description: "What the family entered about Grandad: name, age, what he is wearing today, how to approach him, home address, and a Google Maps link to his last position. Call it before writing any message for neighbours or police.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mark_places_on_map",
    description: "Show numbered pins on the family's map for the places in your search plan, in the order they should be checked. Call it once, after you have chosen the places.",
    input_schema: {
      type: "object",
      properties: { places: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "Exact place names from find_places, in search order." } },
      required: ["places"],
      additionalProperties: false,
    },
  },
];

// Limits that keep the public demo from being used as a general chat proxy.
const MAX_MESSAGES = 40, MAX_BYTES = 200_000, WINDOW_MS = 10 * 60_000, MAX_PER_WINDOW = 40;
const hits = new Map();

function rateLimited(ip){
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now); hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

function badMessages(messages){
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return "messages must be a non-empty list";
  if (messages[0].role !== "user") return "the first message must be from the user";
  if (messages.some(m => !m || (m.role !== "user" && m.role !== "assistant"))) return "only user and assistant messages are allowed";
  if (JSON.stringify(messages).length > MAX_BYTES) return "conversation too long";
  return null;
}

export default async function handler(req, res){
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "not_configured" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate_limited" });
  const messages = req.body?.messages, problem = badMessages(messages);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    return res.status(200).json({ content: response.content, stop_reason: response.stop_reason, stop_details: response.stop_details ?? null });
  } catch (error){
    console.error("helper:", error?.status ?? "", error?.message ?? error);
    if (error instanceof Anthropic.BadRequestError) return res.status(400).json({ error: "bad_request" });
    if (error instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate_limited" });
    if (error instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "not_configured" });
    if (error instanceof Anthropic.APIError) return res.status(502).json({ error: "upstream_error" });
    return res.status(500).json({ error: "server_error" });
  }
}
