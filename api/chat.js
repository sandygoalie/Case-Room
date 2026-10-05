// Serverless proxy to whichever free-tier AI provider the caller picked.
// The caller's own API key travels with each request and is never stored,
// logged, or written anywhere on this server — it's read from the request
// body, used for exactly one outbound fetch, and discarded when the
// function returns.
//
// Six providers, all with a real free tier (no card required to start):
//   - gemini      Google AI Studio
//   - groq        Groq Cloud (fast open-weight models)
//   - openrouter  OpenRouter's ":free" model pool (aggregates several labs)
//   - cerebras    Cerebras Cloud (very fast inference on open models)
//   - mistral     Mistral's "La Plateforme" free tier
//   - nvidia      NVIDIA NIM (build.nvidia.com) hosted open models
//
// Model names below are a best-effort pick as of this writing, not a live
// lookup — free-tier lineups shift over time (this already bit the gemini
// entry once: gemini-2.5-* was retired and replaced with gemini-3.8-flash).
// If a provider starts 404ing on its model name, check that provider's own
// current model list and update its entry here; nothing else needs to change.
const MODELS = {
  gemini: { quick: 'gemini-3.8-flash', default: 'gemini-3.8-flash', complex: 'gemini-3.8-flash' },
  groq: { quick: 'llama-3.1-8b-instant', default: 'llama-3.3-70b-versatile', complex: 'llama-3.3-70b-versatile' },
  openrouter: {
    quick: 'meta-llama/llama-3.2-3b-instruct:free',
    default: 'meta-llama/llama-3.3-70b-instruct:free',
    complex: 'deepseek/deepseek-r1:free',
  },
  cerebras: { quick: 'llama-3.3-70b', default: 'llama-3.3-70b', complex: 'llama-3.3-70b' },
  mistral: { quick: 'open-mistral-nemo', default: 'mistral-small-latest', complex: 'mistral-small-latest' },
  // meta/llama-3.1-8b-instruct (the original pick here) hit end-of-life on
  // NVIDIA's side and 410s — verified these three are live via /v1/models
  nvidia: { quick: 'nvidia/llama-3.1-nemotron-51b-instruct', default: 'nvidia/llama-3.1-nemotron-70b-instruct', complex: 'nvidia/llama-3.1-nemotron-ultra-253b-v1' },
};

// base URL for every provider that speaks the OpenAI chat-completions shape
// (everyone except Gemini, which has its own call function below)
const OPENAI_COMPATIBLE_BASE = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

async function callGemini(apiKey, model, system, messages, maxOutputTokens){
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = { contents, generationConfig: { maxOutputTokens, temperature: 0.9 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const code = (payload && payload.error && payload.error.status) || 'upstream_error';
    const message = (payload && payload.error && payload.error.message) || ('Gemini returned ' + upstream.status);
    return { ok: false, status: upstream.status, error: code, message };
  }
  const candidate = payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) {
    const reason = candidate && candidate.finishReason;
    return { ok: false, status: 502, error: reason === 'SAFETY' ? 'refused' : 'empty_completion', message: 'The model returned no text.' };
  }
  return { ok: true, text };
}

// Every provider except Gemini speaks the OpenAI chat-completions shape.
async function callOpenAiCompatible(baseUrl, apiKey, model, system, messages, maxTokens, extraHeaders){
  const chatMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const upstream = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey }, extraHeaders || {}),
    body: JSON.stringify({ model, messages: chatMessages, max_tokens: maxTokens, temperature: 0.9 }),
  });
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const code = (payload && payload.error && (payload.error.code || payload.error.type)) || 'upstream_error';
    const message = (payload && payload.error && payload.error.message) || ('Request returned ' + upstream.status);
    return { ok: false, status: upstream.status, error: String(code), message };
  }
  const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  if (!text) return { ok: false, status: 502, error: 'empty_completion', message: 'The model returned no text.' };
  return { ok: true, text: text.trim() };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'bad_request', message: 'Expected a JSON body.' });
    return;
  }

  const { apiKey, system, messages, tier, maxTokens, provider } = body;
  const prov = MODELS[provider] ? provider : 'gemini';

  if (!apiKey || typeof apiKey !== 'string') {
    res.status(400).json({ error: 'missing_api_key', message: 'No API key was sent with this request.' });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'messages must be a non-empty array.' });
    return;
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) {
      res.status(400).json({ error: 'bad_request', message: 'Each message needs role "user"|"assistant" and non-empty string content.' });
      return;
    }
  }

  const model = MODELS[prov][tier] || MODELS[prov].default;
  const maxOut = Math.min(Math.max(Number(maxTokens) || 1024, 1), 8192);
  const sys = typeof system === 'string' ? system : undefined;

  let result;
  try {
    if (prov === 'gemini') {
      result = await callGemini(apiKey, model, sys, messages, maxOut);
    } else {
      const extraHeaders = prov === 'openrouter' ? { 'HTTP-Referer': 'https://case-room.vercel.app', 'X-Title': 'Case Room' } : undefined;
      result = await callOpenAiCompatible(OPENAI_COMPATIBLE_BASE[prov], apiKey, model, sys, messages, maxOut, extraHeaders);
    }
  } catch (e) {
    res.status(502).json({ error: 'upstream_unreachable', message: 'Could not reach ' + prov + '.' });
    return;
  }

  if (!result.ok) {
    res.status(result.status || 502).json({ error: result.error, message: result.message });
    return;
  }

  res.status(200).json({ text: result.text, model, provider: prov });
};
