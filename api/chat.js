// Serverless proxy to whichever free-tier AI provider the caller picked.
// The caller's own API key travels with each request and is never stored,
// logged, or written anywhere on this server — it's read from the request
// body, used for exactly one outbound fetch, and discarded when the
// function returns.
//
// Three providers, all with a real free tier (no card required to start):
//   - gemini      Google AI Studio
//   - groq        Groq Cloud (fast open-weight models)
//   - openrouter  OpenRouter's ":free" model pool (aggregates several labs)

const MODELS = {
  gemini: { quick: 'gemini-2.5-flash-lite', default: 'gemini-2.5-flash', complex: 'gemini-2.5-pro' },
  groq: { quick: 'llama-3.1-8b-instant', default: 'llama-3.3-70b-versatile', complex: 'llama-3.3-70b-versatile' },
  openrouter: {
    quick: 'meta-llama/llama-3.2-3b-instruct:free',
    default: 'meta-llama/llama-3.3-70b-instruct:free',
    complex: 'deepseek/deepseek-r1:free',
  },
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

// Groq and OpenRouter both speak the OpenAI chat-completions shape.
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
    } else if (prov === 'groq') {
      result = await callOpenAiCompatible('https://api.groq.com/openai/v1', apiKey, model, sys, messages, maxOut);
    } else {
      result = await callOpenAiCompatible('https://openrouter.ai/api/v1', apiKey, model, sys, messages, maxOut, {
        'HTTP-Referer': 'https://case-room.vercel.app',
        'X-Title': 'Case Room',
      });
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
