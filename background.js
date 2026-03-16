// XReply AI v4 — Background Service Worker

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    generateReply:      () => handleGenerate(request, sendResponse),
    generateVariants:   () => handleVariants(request, sendResponse),
    regenerateVariant:  () => handleRegenerateVariant(request, sendResponse),
    generateThread:     () => handleThread(request, sendResponse),
    generateAB:         () => handleAB(request, sendResponse),
    getSettings:        () => { chrome.storage.local.get(null, l => chrome.storage.sync.get(null, s => sendResponse({...s,...l}))); },
    trackUsage:         () => { trackAPIUsage(request.provider, request.tokens || 0); sendResponse({ok:true}); },
  };
  if (handlers[request.action]) { handlers[request.action](); return true; }
});

// ── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
  const [local, sync] = await Promise.all([
    new Promise(r => chrome.storage.local.get(null, r)),
    new Promise(r => chrome.storage.sync.get(null, r))
  ]);
  return { ...sync, ...local };
}

// ── Usage Tracking ────────────────────────────────────────────────────────────

async function trackAPIUsage(provider, tokens) {
  try {
    const { usage = {} } = await chrome.storage.local.get(['usage']);
    const today = new Date().toISOString().slice(0, 10);
    if (!usage[provider]) usage[provider] = {};
    if (!usage[provider][today]) usage[provider][today] = { calls: 0, tokens: 0 };
    usage[provider][today].calls++;
    usage[provider][today].tokens += tokens;
    await chrome.storage.local.set({ usage });
  } catch (_) {}
}

// ── Cost per 1k tokens (approx) ───────────────────────────────────────────────
const COST_PER_1K = { claude: 0.015, openai: 0.005, gemini: 0.00035, grok: 0.01, groq: 0 };

// ── Tone Prompts ──────────────────────────────────────────────────────────────

const TONE_PROMPTS = {
  funny: `Write a funny, human reply — dry wit, clever callback, or absurd observation. Effortless, not try-hard. Only be funny about THIS tweet's actual content.`,
  bigbrain: `One non-obvious insight that reframes the conversation. No padding. No openers. Just the point. Only claim what you're certain of.`,
  knowledge: `One specific, concrete piece of knowledge about this exact topic. Text a curious friend — not a Wikipedia entry. NEVER invent stats or names.`,
  ragebait: `Bold, contrarian take that makes people stop and think "wait, but actually..." Debatable not hateful. Grounded in this topic specifically.`,
  agree: `Genuinely agree AND add something — your angle, example, or observation. Build on their point. Make their tweet look better too.`,
  thread: `Opening hook that makes people tap "show more". Format: bold claim + 2-3 tease lines. Confident insider tone. Max 500 chars.`,
  flirt: `Playful, teasing, suggestive reply with double meaning. Witty — leaves something to imagination. One line hits hardest. ONLY if tweet context invites it.`,
};

const NICHE_PROMPTS = {
  crypto: `You're deeply embedded in Crypto Twitter (CT). You know the memes, the cycles, the FUD, the FOMO. You use terms like ngmi, wagmi, gm, ser, fren naturally — but not forced. You've been through multiple bear markets.`,
  saas: `You're a SaaS founder or operator. You talk about MRR, churn, PLG, ICP, GTM naturally. You follow indie hackers and B2B SaaS builders. Blunt, metrics-driven, occasionally sarcastic about VC culture.`,
  fitness: `You're deep in fitness culture. You talk about PRs, macros, progressive overload, natty vs enhanced debates. Gym humor, bro science callouts, and genuine training advice. High energy but grounded.`,
  finance: `You follow markets, personal finance, and investing. You know the difference between value investing and momentum. You're cynical about financial media but genuinely curious about fundamentals.`,
  tech: `You work in tech — maybe a dev, PM, or founder. You have opinions on AI hype, cloud costs, framework wars. Dry humor, high standards, low tolerance for buzzwords.`,
  creator: `You're a content creator who thinks about growth, monetization, audience psychology. You know what hooks work, what algorithms reward, and you're honest about the hustle.`,
};

const LENGTH_INSTRUCTIONS = {
  short:  'Under 100 characters. One punchy sentence.',
  medium: '100-200 characters. 1-2 sentences.',
  long:   '200-280 characters. 2-3 sentences.',
};

// ── Provider Calls ────────────────────────────────────────────────────────────

async function callProvider({ provider, apiKey, systemPrompt, userPrompt, maxTokens }) {
  switch (provider) {
    case 'gemini': return callGemini({ apiKey, systemPrompt, userPrompt, maxTokens });
    case 'openai': return callOpenAI({ apiKey, systemPrompt, userPrompt, maxTokens });
    case 'grok':   return callGrok({ apiKey, systemPrompt, userPrompt, maxTokens });
    case 'groq':   return callGroq({ apiKey, systemPrompt, userPrompt, maxTokens });
    default:       return callClaude({ apiKey, systemPrompt, userPrompt, maxTokens });
  }
}

async function callClaude({ apiKey, systemPrompt, userPrompt, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Claude ${res.status}`); }
  const d = await res.json();
  return d.content?.[0]?.text?.trim();
}

async function callGemini({ apiKey, systemPrompt, userPrompt, maxTokens }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: userPrompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 } })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Gemini ${res.status}`); }
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
}

async function callOpenAI({ apiKey, systemPrompt, userPrompt, maxTokens }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `OpenAI ${res.status}`); }
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim();
}

async function callGrok({ apiKey, systemPrompt, userPrompt, maxTokens }) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'grok-3-latest', max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Grok ${res.status}`); }
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim();
}

async function callGroq({ apiKey, systemPrompt, userPrompt, maxTokens }) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `Groq ${res.status}`); }
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim();
}

// ── Vision ────────────────────────────────────────────────────────────────────

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve({ base64: reader.result.split(',')[1], mediaType: blob.type || 'image/jpeg' });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

async function callProviderWithImages({ provider, apiKey, systemPrompt, textPrompt, imageUrls, maxTokens }) {
  const images = (await Promise.all(imageUrls.map(fetchImageAsBase64))).filter(Boolean);
  if (!images.length) return callProvider({ provider, apiKey, systemPrompt, userPrompt: textPrompt, maxTokens });

  if (provider === 'claude') {
    const imageBlocks = images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } }));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: textPrompt }] }] })
    });
    if (!res.ok) throw new Error(`Claude vision ${res.status}`);
    const d = await res.json(); return d.content?.[0]?.text?.trim();
  }
  if (provider === 'openai') {
    const imgContents = images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' } }));
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: [...imgContents, { type: 'text', text: textPrompt }] }] })
    });
    if (!res.ok) throw new Error(`OpenAI vision ${res.status}`);
    const d = await res.json(); return d.choices?.[0]?.message?.content?.trim();
  }
  if (provider === 'gemini') {
    const imgParts = images.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.base64 } }));
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [...imgParts, { text: textPrompt }] }], generationConfig: { maxOutputTokens: maxTokens } })
    });
    if (!res.ok) throw new Error(`Gemini vision ${res.status}`);
    const d = await res.json(); return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  }
  return callProvider({ provider, apiKey, systemPrompt, userPrompt: textPrompt, maxTokens });
}

// ── Tweet Analyzer ────────────────────────────────────────────────────────────

async function analyzeTweet({ threadContext, draftText, apiKey, provider }) {
  if (!threadContext?.length && !draftText) return null;
  // Use the primary tweet for analysis, not all tweets blended together
  const primaryTweet = threadContext?.find(t => t.isPrimary) || threadContext?.[threadContext.length - 1];
  const tweetText = primaryTweet?.text || (threadContext?.length ? threadContext.map(t => t.text).join(' | ') : draftText);
  const imageUrls = [];
  if (threadContext?.length) { for (const t of threadContext) { if (t.images?.length) imageUrls.push(...t.images); if (imageUrls.length >= 2) break; } }

  const systemPrompt = `Analyze tweets for a reply assistant. Output ONLY valid JSON, no markdown.`;
  const userPrompt = `Return ONLY this JSON:
{"topic":"2-4 word topic","sentiment":"positive|negative|neutral|controversial|humorous","intent":"one sentence","tone":"casual|formal|angry|excited|sarcastic|informative|sad","hook":"best replyable angle","hasImage":${imageUrls.length > 0},"imageDescription":"${imageUrls.length > 0 ? 'describe image' : 'none'}","language":"English|Hindi|Hinglish|etc"}
Tweet: "${tweetText.slice(0, 500)}"`;

  try {
    let raw;
    if (imageUrls.length > 0 && ['claude', 'openai', 'gemini'].includes(provider)) {
      raw = await callProviderWithImages({ provider, apiKey, systemPrompt, textPrompt: userPrompt, imageUrls, maxTokens: 250 });
    } else {
      raw = await callProvider({ provider, apiKey, systemPrompt, userPrompt, maxTokens: 250 });
    }
    const stripped = raw.split('```json').join('').split('```').join('').trim();
    return JSON.parse(stripped);
  } catch { return null; }
}

// ── Anti-AI Humanizer ─────────────────────────────────────────────────────────

function humanizeText(text) {
  if (!text) return text;
  let t = text;
  const badOpeners = [/^(great|absolutely|certainly|indeed|of course|definitely|exactly|precisely|truly|honestly|frankly|clearly|obviously)[,!]?\s+/i, /^(i think|i believe|i feel|in my opinion|as an ai|as a language model)[,\s]/i, /^(let me|allow me to|i'd like to|i want to)[,\s]/i];
  badOpeners.forEach(rx => { t = t.replace(rx, ''); });
  t = t.replace(/^I (think|believe|feel|know|agree|disagree|would|want|just)\s+/i, (m, verb) => ({ think: 'Honestly, ', believe: 'Honestly, ', feel: '', know: '', agree: '', just: '' }[verb.toLowerCase()] || ''));
  t = t.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ' - ');
  const formalMap = [['furthermore','also'],['moreover','plus'],['however','but'],['nevertheless','still'],['utilize','use'],['facilitate','help'],['demonstrate','show'],['commence','start'],['in conclusion',''],['in summary',''],['it is worth noting that',''],['it is important to note that',''],['the fact that',''],['at the end of the day','ultimately'],['when it comes to','for'],['one could argue','arguably']];
  formalMap.forEach(([f, r]) => { t = t.replace(new RegExp(f, 'gi'), r); });
  t = t.replace(/!{2,}/g, '!');
  const ec = (t.match(/!/g) || []).length;
  if (ec > 1 && t.length < 200) { let n = 0; t = t.replace(/!/g, () => (++n < ec ? '.' : '!')); }
  const hm = t.match(/#\w+/g) || [];
  if (hm.length > 1) t = t.replace(/((\s+#\w+){2,})$/, '');
  t = t.replace(/\s{2,}/g, ' ').trim().replace(/^,\s+/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Build System Prompt ───────────────────────────────────────────────────────

function buildSystemPrompt({ tone, length, customPersona, nicheKey, tweetAnalysis, primaryTweetText }) {
  const toneInstruction   = TONE_PROMPTS[tone]   || TONE_PROMPTS.bigbrain;
  const lengthInstruction = LENGTH_INSTRUCTIONS[length] || LENGTH_INSTRUCTIONS.medium;
  const nicheSection      = nicheKey && NICHE_PROMPTS[nicheKey] ? `\n\nNICHE CONTEXT:\n${NICHE_PROMPTS[nicheKey]}` : '';
  const personaSection    = customPersona ? `\n\nYOUR PERSONA:\n${customPersona}` : '';
  const imageContext      = tweetAnalysis?.hasImage && tweetAnalysis?.imageDescription !== 'none'
    ? `\n- The tweet contains an image showing: ${tweetAnalysis.imageDescription}. You may reference what is actually visible.` : '';
  const analysisBlock     = tweetAnalysis ? `\n\nTWEET UNDERSTANDING:\n- Topic: ${tweetAnalysis.topic}\n- What author is saying: ${tweetAnalysis.intent}\n- Best angle: ${tweetAnalysis.hook}\n- Language: ${tweetAnalysis.language}\nReply in ${tweetAnalysis.language}.` : '';
  const primaryBlock      = primaryTweetText ? `\n\nTHE EXACT TWEET YOU ARE REPLYING TO:\n"${primaryTweetText}"\n\nYour reply MUST be a direct response to this specific tweet.` : '';

  return `You are a real person replying on X (Twitter).

TONE: ${toneInstruction}
LENGTH: ${lengthInstruction}

STRICT CONTENT RULES — read carefully:
- Reply ONLY about what is EXPLICITLY stated in the tweet above. Nothing more.
- Do NOT add product names, prices, specs, or details that are not in the tweet text.
- Do NOT invent numbers, statistics, brand names, or facts. If it's not in the tweet, don't say it.
- If you're not 100% sure of a fact, speak generally — do not guess.
- Make your reply feel like a natural human response to exactly what was said.

TONE RULES:
- Sound human: casual contractions, direct, varied sentence length
- No "Great point!", no em-dashes, no bullet points, no openers
- One clear idea. Don't stuff it.

LANGUAGE: Reply in the SAME language as the tweet.${primaryBlock}${imageContext}${nicheSection}${personaSection}${analysisBlock}`;
}

// ── Core Generation ───────────────────────────────────────────────────────────

async function generateOne({ tone, length = 'medium', threadContext = [], draftText = '', customPersona = '', nicheKey = '', apiKey, provider = 'claude', tweetAnalysis = null }) {
  // Extract the primary tweet (the one being directly replied to)
  const primaryTweet = threadContext?.find(t => t.isPrimary) || threadContext?.[threadContext.length - 1];
  const primaryTweetText = primaryTweet?.text || draftText || '';

  const systemPrompt = buildSystemPrompt({ tone, length, customPersona, nicheKey, tweetAnalysis, primaryTweetText });

  // Build context — only include thread if more than 1 tweet (actual thread)
  let contextBlock = '';
  if (threadContext?.length > 1) {
    const others = threadContext.filter(t => !t.isPrimary);
    if (others.length) {
      contextBlock = '\n\nTHREAD HISTORY (for context only):\n' + others.map((t, i) => `@${t.author}: "${t.text}"`).join('\n') + '\n';
    }
  }
  const draftBlock = draftText && draftText !== primaryTweetText ? `\n\nUSER DRAFT: "${draftText.slice(0, 280)}"\n` : '';
  const userPrompt = `Reply to the tweet.${contextBlock}${draftBlock}\nReply:`;
  const maxTokens = tone === 'thread' ? 600 : 350;

  try {
    const text = await callProvider({ provider, apiKey, systemPrompt, userPrompt, maxTokens });
    if (!text) return { error: 'Empty response — try again.' };
    const { antiAI } = await chrome.storage.sync.get(['antiAI']);
    const humanText = antiAI !== false ? humanizeText(text) : text;

    // Log + track usage
    try {
      const { replyLog = [] } = await chrome.storage.local.get(['replyLog']);
      const context = threadContext?.[threadContext.length - 1]?.text || '';
      replyLog.push({ tone, length, provider, text: humanText, context: context.slice(0, 120), ts: Date.now(), stars: 0 });
      if (replyLog.length > 100) replyLog.splice(0, replyLog.length - 100);
      await chrome.storage.local.set({ replyLog });
    } catch (_) {}
    trackAPIUsage(provider, maxTokens);

    return { text: humanText };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Thread Generator ──────────────────────────────────────────────────────────

async function handleThread(request, sendResponse) {
  const settings = await getSettings();
  const provider = settings.activeProvider || 'claude';
  const apiKey   = settings[`apiKey_${provider}`];
  if (!apiKey) { sendResponse({ error: `No API key for ${provider}.` }); return; }

  const tweetAnalysis = request.tweetAnalysis || await analyzeTweet({ threadContext: request.threadContext, draftText: request.draftText, apiKey, provider });

  const topic = request.topic || request.draftText || tweetAnalysis?.topic || 'this topic';
  const nicheKey = settings.nicheKey || '';
  const nicheCtx = nicheKey && NICHE_PROMPTS[nicheKey] ? `\nNiche context: ${NICHE_PROMPTS[nicheKey]}` : '';
  const personaCtx = settings.customPersona ? `\nYour voice: ${settings.customPersona}` : '';

  const systemPrompt = `You write viral Twitter threads. Each tweet must hook into the next. Human voice, no AI tells.${nicheCtx}${personaCtx}`;
  const userPrompt = `Write a 6-tweet thread about: "${topic}"
Format EXACTLY like this — each tweet on its own line, prefixed with TWEET_N: (N=1,2,3,4,5,6)
TWEET_1: [hook — bold claim or surprising question, max 240 chars]
TWEET_2: [first insight/story beat, max 240 chars]
TWEET_3: [second insight, stat or example, max 240 chars]
TWEET_4: [third insight — the twist or deeper angle, max 240 chars]
TWEET_5: [practical takeaway, max 240 chars]
TWEET_6: [CTA — follow for more, share if useful, or question to audience, max 200 chars]

Rules: No hashtags. No "1/6" numbering. No em-dashes. Each tweet must stand alone but tease the next.`;

  try {
    const raw = await callProvider({ provider, apiKey, systemPrompt, userPrompt, maxTokens: 1200 });
    const tweets = [];
    for (let i = 1; i <= 6; i++) {
      const match = raw.match(new RegExp(`TWEET_${i}:\\s*(.+?)(?=TWEET_${i+1}:|$)`, 's'));
      if (match) tweets.push(match[1].trim());
    }
    if (tweets.length < 3) { sendResponse({ error: 'Thread generation failed — try again.' }); return; }
    sendResponse({ tweets });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ── A/B Handler ───────────────────────────────────────────────────────────────

async function handleAB(request, sendResponse) {
  const settings = await getSettings();
  const provider = settings.activeProvider || 'claude';
  const apiKey   = settings[`apiKey_${provider}`];
  if (!apiKey) { sendResponse({ error: `No API key for ${provider}.` }); return; }

  const tweetAnalysis = await analyzeTweet({ threadContext: request.threadContext, draftText: request.draftText, apiKey, provider });
  const [toneA, toneB] = request.tones || ['funny', 'bigbrain'];

  try {
    const [resultA, resultB] = await Promise.all([
      generateOne({ tone: toneA, length: request.length || 'medium', threadContext: request.threadContext, draftText: request.draftText, customPersona: settings.customPersona || '', nicheKey: settings.nicheKey || '', provider, apiKey, tweetAnalysis }),
      generateOne({ tone: toneB, length: request.length || 'medium', threadContext: request.threadContext, draftText: request.draftText, customPersona: settings.customPersona || '', nicheKey: settings.nicheKey || '', provider, apiKey, tweetAnalysis }),
    ]);
    sendResponse({ a: { tone: toneA, text: resultA.text, error: resultA.error }, b: { tone: toneB, text: resultB.text, error: resultB.error } });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ── Main Handlers ─────────────────────────────────────────────────────────────

async function handleGenerate(request, sendResponse) {
  const settings = await getSettings();
  const provider = settings.activeProvider || 'claude';
  const apiKey   = settings[`apiKey_${provider}`];
  if (!apiKey) { sendResponse({ error: `No API key for ${provider}. Open XReply AI → API Keys.` }); return; }

  const tweetAnalysis = request.tweetAnalysis || await analyzeTweet({ threadContext: request.threadContext, draftText: request.draftText, apiKey, provider });
  const result = await generateOne({ ...request, provider, apiKey, customPersona: settings.customPersona || '', nicheKey: settings.nicheKey || '', tweetAnalysis });
  sendResponse(result);
}

async function handleVariants(request, sendResponse) {
  const settings = await getSettings();
  const provider = settings.activeProvider || 'claude';
  const apiKey   = settings[`apiKey_${provider}`];
  if (!apiKey) { sendResponse({ error: `No API key for ${provider}.` }); return; }

  const variantTones = request.tones || ['funny', 'bigbrain', 'agree'];
  try {
    const tweetAnalysis = await analyzeTweet({ threadContext: request.threadContext, draftText: request.draftText, apiKey, provider });
    const results = await Promise.all(variantTones.map(tone => generateOne({ tone, length: 'medium', threadContext: request.threadContext, draftText: request.draftText, customPersona: settings.customPersona || '', nicheKey: settings.nicheKey || '', provider, apiKey, tweetAnalysis })));
    sendResponse({ variants: results.map((res, i) => ({ tone: variantTones[i], text: res.text || null, error: res.error || null })), tweetAnalysis });
  } catch (err) { sendResponse({ error: err.message }); }
}

async function handleRegenerateVariant(request, sendResponse) {
  const settings = await getSettings();
  const provider = settings.activeProvider || 'claude';
  const apiKey   = settings[`apiKey_${provider}`];
  if (!apiKey) { sendResponse({ error: `No API key for ${provider}.` }); return; }

  try {
    const tweetAnalysis = request.tweetAnalysis || await analyzeTweet({ threadContext: request.threadContext, draftText: request.draftText, apiKey, provider });
    const result = await generateOne({ tone: request.tone, length: 'medium', threadContext: request.threadContext, draftText: request.draftText, customPersona: settings.customPersona || '', nicheKey: settings.nicheKey || '', provider, apiKey, tweetAnalysis });
    sendResponse({ text: result.text || null, error: result.error || null });
  } catch (err) { sendResponse({ error: err.message }); }
}


// ── Post Idea Generator ───────────────────────────────────────────────────────
// Generates original tweet ideas based on persona + niche when post box opens

async function handlePostIdeas(request, sendResponse) {
  const settings = await getSettings();
  const provider  = settings.activeProvider || 'claude';
  const apiKey    = settings[`apiKey_${provider}`];
  if (!apiKey) { sendResponse({ error: `No API key for ${provider}.` }); return; }

  const customPersona = settings.customPersona || '';
  const topics        = settings.topics || '';
  const nicheKey      = settings.nicheKey || '';
  const nicheCtx      = nicheKey && NICHE_PROMPTS[nicheKey] ? NICHE_PROMPTS[nicheKey] : '';
  const draftText     = request.draftText || '';

  const systemPrompt = `You write viral original tweets for X (Twitter). You write exactly like the persona described — not like an AI assistant.

${customPersona ? `PERSONA:
${customPersona}` : ''}
${nicheCtx ? `
NICHE: ${nicheCtx}` : ''}
${topics ? `
TOPICS THIS PERSON POSTS ABOUT: ${topics}` : ''}

RULES:
- Output ONLY the tweet text. No labels, no numbering, no explanation.
- Sound completely human. Real person energy.
- No hashtags unless essential. No em-dashes. No bullet points.
- Each tweet should feel like something THIS specific person would genuinely post.
- Vary the format: one can be a hot take, one an insight, one a personal observation.`;

  const draftContext = draftText ? `
User started typing: "${draftText}" — expand or improve this idea.` : '';
  const userPrompt = `Generate 3 original tweet ideas.${draftContext}
Format EXACTLY — each tweet on its own line, prefixed with TWEET_N:
TWEET_1: [tweet text]
TWEET_2: [tweet text]  
TWEET_3: [tweet text]`;

  try {
    const raw = await callProvider({ provider, apiKey, systemPrompt, userPrompt, maxTokens: 500 });
    if (!raw) { sendResponse({ error: 'Empty response.' }); return; }

    const ideas = [];
    for (let i = 1; i <= 3; i++) {
      const match = raw.match(new RegExp(`TWEET_${i}:\s*(.+?)(?=TWEET_${i+1}:|$)`, 's'));
      if (match) ideas.push(match[1].trim());
    }

    // Fallback: split by newlines if prefix format failed
    if (!ideas.length) {
      raw.split('\n').filter(l => l.trim().length > 10).slice(0, 3).forEach(l => {
        ideas.push(l.replace(/^TWEET_\d+:\s*/,'').trim());
      });
    }

    sendResponse({ ideas: ideas.filter(Boolean) });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}
