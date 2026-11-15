// Search helper: an AI agent that plans a search and answers questions about Grandad's day.
// The page runs the tools (it holds the map, the routing and the day's record); this function
// adds the fixed instructions, tool list and model, and keeps the API key off the page.
//
// Provider: Gemini when GEMINI_API_KEY is set (free tier), otherwise Claude when
// ANTHROPIC_API_KEY is set. The page and this function talk in a small neutral format:
//   request  { history: [{role: "user", text} | {role: "assistant", raw} | {role: "tool_results", results: [{id, name, content, is_error}]}] }
//   response { raw, tool_calls: [{id, name, input}], text, stop: "tool_use" | "end" | "max_tokens" | "refusal" }
// `raw` is the provider's own turn, which the page sends back unchanged.
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM = `You are the search helper inside Grandad's Compass, a family dashboard for an 84-year-old man with Alzheimer's who lives in Sahakarnagar, Bengaluru. His phone is sewn into his jacket and reports his position. The family uses you when he may be lost, may have fallen, or when they have a question about his day. This copy is a prototype running a simulated walk on the real street map. The dashboard has already shown the family a quick rule-based plan; your job is to add judgement and clear writing on top of it.

How to work:
- Start every task with get_status. Make independent tool calls together in one step (for example get_status, get_movement, get_today_log, find_places and get_person_details at once) so the plan needs as few steps as possible. Base every statement on tool results: never invent places, streets, distances, times or habits. If the tools don't tell you something, say you don't know.
- Distances to places must come from find_places or walking_route (they follow real roads). Directions like "north-east" come from the tools too.
- He speaks Tamil. Messages for people who might find him should be in simple Tamil and English, and use the details from get_person_details.

Safety rules:
- The dashboard's alerts are the source of truth. Never tell the family to ignore, cancel or wait out an urgent alert, and never suggest delaying a call to the police when he is outside the safe zone or may have fallen.
- For a possible fall, the first step is always to call his phone and send the nearest person to his last position now; if he can't be reached quickly, call 112.
- You are not a doctor. Don't give medical advice beyond "call 112" and "stay with him".

Writing style: plain, calm, short sentences a worried person can read on a phone. No em dashes. Use short headings and numbered lists only where they help. Keep answers under 250 words unless the family asks for more.

When asked to plan a search:
1. One line on where he is, how long he has been there or how he is moving, and the time.
2. "Where to look first": 3 or 4 places in order, each with the walking distance from his last position and a short reason. Only say he went somewhere, likes somewhere or was heading somewhere if a tool result shows it (visited_today, the today log, or his movement). Otherwise give an honest reason, such as "the closest bus stop" or "a temple, the kind of place people often stop at". Call mark_places_on_map with the same places in the same order.
3. "Who goes where": if the family hasn't said who is available, assume two people at home. Person 1 always goes straight to his last position first. Give each person their places in order and the walking route summary from home.
4. "Message to send": a short message in Tamil and in English for neighbours, shopkeepers and the police. Each version must include his name and age, what he is wearing, his last position, the Google Maps link, and end with "Call 112".

When asked to explain an alert: say in two or three sentences what the alert means, add the context from the tools (where he is, whether this matches what he did earlier today, how long he usually stays), and end with one clear next step. Context can calm a "check" alert, but an "urgent" alert always gets an action.`;

const KINDS = ["temple", "park", "bus", "bakery", "cafe", "shop", "pharmacy", "hospital", "post"];
const FROM = { type: "string", enum: ["him", "home"], description: "Start from his current position (default) or from home." };
const NONE = { type: "object", properties: {} };

const TOOLS = [
  {
    name: "get_status",
    description: "Where Grandad is right now: the time, what he is doing, the nearest street, corner or landmark, his distance and direction from home, whether he is inside the safe zone and by how much, minutes since he last moved, his heading, phone battery, coordinates, and the alerts that are still open. Call this first in every task.",
    parameters: NONE,
  },
  {
    name: "get_movement",
    description: "His recent path as stretches: each stop at one spot (with start and end time) or about 2 minutes of walking, with the nearest street or landmark and distance from home. Use it to work out which way he was heading and where he slowed down or stopped.",
    parameters: { type: "object", properties: { minutes: { type: "integer", description: "How far back to look, in minutes, from 5 to 240. Default 60." } } },
  },
  {
    name: "get_today_log",
    description: "Today's record: every place he stopped at and for how long, every safe-zone crossing, every alert with its status, plus steps, distance walked and time out of home. Use it for questions about his day and to learn his usual places.",
    parameters: NONE,
  },
  {
    name: "find_places",
    description: "Named places on the map ranked by walking distance along real roads from Grandad's current position or from home. Each result has the place's exact name, kind, walking distance, direction, whether it is inside the safe zone and whether he went there today. Use it to choose where to look and to answer questions about what is nearby.",
    parameters: {
      type: "object",
      properties: {
        from: FROM,
        kinds: { type: "array", items: { type: "string", enum: KINDS }, description: "Only these kinds of place. Leave out for all kinds." },
        limit: { type: "integer", description: "How many places to return, from 1 to 19. Default 8." },
      },
    },
  },
  {
    name: "walking_route",
    description: "The walking route along real roads from Grandad's current position (or from home) to a named place: distance in metres, minutes at a normal adult pace, and the streets in order. Use it when sending someone to a place.",
    parameters: {
      type: "object",
      properties: { to: { type: "string", description: "The place's exact name, as find_places returns it." }, from: FROM },
      required: ["to"],
    },
  },
  {
    name: "get_person_details",
    description: "What the family entered about Grandad: name, age, what he is wearing today, how to approach him, home address, and a Google Maps link to his last position. Call it before writing any message for neighbours or police.",
    parameters: NONE,
  },
  {
    name: "mark_places_on_map",
    description: "Show numbered pins on the family's map for the places in your search plan, in the order they should be checked. Call it once, after you have chosen the places.",
    parameters: {
      type: "object",
      properties: { places: { type: "array", items: { type: "string" }, description: "Exact place names from find_places, in search order (1 to 6)." } },
      required: ["places"],
    },
  },
];

/* ---------- Gemini (Interactions API, stateless) ---------- */
// Flash-Lite: its free tier allows more requests per minute than Flash (Flash allows 5, and one plan takes 3 to 5)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_TOOLS = TOOLS.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));

function toGeminiSteps(history){
  const steps = [];
  for (const h of history){
    if (h.role === "user") steps.push({ type: "user_input", content: [{ type: "text", text: h.text }] });
    else if (h.role === "assistant") steps.push(...h.raw);
    else for (const r of h.results) steps.push({ type: "function_result", name: r.name, call_id: r.id, result: [{ type: "text", text: r.is_error ? "Error: " + r.content : r.content }] });
  }
  return steps;
}

async function askGemini(history){
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      model: GEMINI_MODEL, store: false, system_instruction: SYSTEM, tools: GEMINI_TOOLS,
      generation_config: { thinking_level: "medium" }, input: toGeminiSteps(history),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok){
    const err = new Error(data.error?.message || `Gemini ${r.status}`); err.status = r.status;
    const wait = String(data.error?.message || "").match(/retry in (\d+(?:\.\d+)?)s/i);
    if (wait) err.retryAfter = Math.ceil(+wait[1]);
    throw err;
  }
  const steps = data.steps || [];
  const tool_calls = steps.filter(s => s.type === "function_call").map(s => ({ id: s.id, name: s.name, input: s.arguments || {} }));
  const text = steps.filter(s => s.type === "model_output").flatMap(s => s.content || []).filter(c => c.type === "text").map(c => c.text).join("\n\n");
  const stop = tool_calls.length ? "tool_use" : data.status === "completed" ? "end" : "max_tokens";
  return { raw: steps, tool_calls, text, stop };
}

/* ---------- Claude ---------- */
let anthropic = null;
const CLAUDE_TOOLS = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

function toClaudeMessages(history){
  return history.map(h => h.role === "user" ? { role: "user", content: h.text }
    : h.role === "assistant" ? { role: "assistant", content: h.raw }
    : { role: "user", content: h.results.map(r => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) })) });
}

async function askClaude(history){
  anthropic ||= new Anthropic();
  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    tools: CLAUDE_TOOLS,
    messages: toClaudeMessages(history),
  });
  const tool_calls = response.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, input: b.input || {} }));
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n\n");
  const stop = { tool_use: "tool_use", end_turn: "end", max_tokens: "max_tokens", refusal: "refusal" }[response.stop_reason] || "end";
  return { raw: response.content, tool_calls, text, stop };
}

const provider = () => process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "claude" : null;

/* ---------- request handling ---------- */
// Limits that keep the public demo from being used as a general chat proxy.
const MAX_ITEMS = 40, MAX_BYTES = 200_000, MAX_TEXT = 600, WINDOW_MS = 10 * 60_000, MAX_PER_WINDOW = 40;
const hits = new Map();

function rateLimited(ip){
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now); hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

function badHistory(history){
  if (!Array.isArray(history) || !history.length || history.length > MAX_ITEMS) return "history must be a non-empty list";
  if (history[0]?.role !== "user") return "the first item must be from the user";
  for (const h of history){
    if (h?.role === "user"){ if (typeof h.text !== "string" || !h.text.trim() || h.text.length > MAX_TEXT) return "bad user text"; }
    else if (h?.role === "assistant"){ if (!Array.isArray(h.raw)) return "bad assistant turn"; }
    else if (h?.role === "tool_results"){ if (!Array.isArray(h.results) || h.results.some(r => typeof r?.id !== "string" || typeof r?.name !== "string" || typeof r?.content !== "string")) return "bad tool results"; }
    else return "unknown role";
  }
  if (JSON.stringify(history).length > MAX_BYTES) return "conversation too long";
  return null;
}

export default async function handler(req, res){
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ai: provider() });
  if (req.method !== "POST") return res.status(405).json({ error: "Use GET or POST." });
  const which = provider();
  if (!which) return res.status(503).json({ error: "not_configured" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate_limited" });
  const history = req.body?.history, problem = badHistory(history);
  if (problem) return res.status(400).json({ error: problem });

  try {
    return res.status(200).json(await (which === "gemini" ? askGemini(history) : askClaude(history)));
  } catch (error){
    console.error("helper:", which, error?.status ?? "", error?.message ?? error);
    if (error instanceof Anthropic.AuthenticationError || error?.status === 401 || error?.status === 403) return res.status(503).json({ error: "not_configured" });
    if (error instanceof Anthropic.RateLimitError || error?.status === 429) return res.status(429).json({ error: "rate_limited", retry_after: error.retryAfter ?? null });
    if (error instanceof Anthropic.BadRequestError || error?.status === 400) return res.status(400).json({ error: "bad_request" });
    return res.status(502).json({ error: "upstream_error" });
  }
}
