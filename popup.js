// XReply AI v4 — Popup

document.addEventListener('DOMContentLoaded', async () => {

  // ── Load settings ───────────────────────────────────────────────────────────
  const [savedLocal, savedSync] = await Promise.all([
    chrome.storage.local.get(['activeProvider','apiKey_claude','apiKey_gemini','apiKey_openai','apiKey_grok','apiKey_groq','replyLog','replyQueue','usage']),
    chrome.storage.sync.get(['defaultTone','autoGenerate','customPersona','topics','theme','autoOpenReply','autoOpenPost','antiAI','nicheKey'])
  ]);
  const saved = { ...savedSync, ...savedLocal };

  // ── Theme ───────────────────────────────────────────────────────────────────
  applyTheme(saved.theme || 'dark');
  document.querySelectorAll('.theme-chip').forEach(c => c.classList.toggle('active', c.dataset.theme === (saved.theme||'dark')));

  // ── API Keys ────────────────────────────────────────────────────────────────
  const providers = ['claude','gemini','openai','grok','groq'];
  providers.forEach(p => { const el = document.getElementById(`apiKey_${p}`); if (el && saved[`apiKey_${p}`]) el.value = saved[`apiKey_${p}`]; });
  setActiveProvider(saved.activeProvider || 'claude');
  updateStatusDot(providers.some(p => saved[`apiKey_${p}`]));

  // ── Settings ────────────────────────────────────────────────────────────────
  const defaultTone = saved.defaultTone || 'bigbrain';
  document.querySelectorAll('.tone-chip').forEach(c => c.classList.toggle('active', c.dataset.tone === defaultTone));
  document.getElementById('autoGenerate') && (document.getElementById('autoGenerate').checked = saved.autoGenerate !== false);
  document.getElementById('autoOpenReply').checked = saved.autoOpenReply !== false;
  document.getElementById('autoOpenPost').checked  = saved.autoOpenPost === true;
  document.getElementById('antiAI').checked         = saved.antiAI !== false;
  if (saved.customPersona) document.getElementById('customPersona').value = saved.customPersona;
  if (saved.topics) document.getElementById('topics').value = saved.topics;

  // ── Niche ───────────────────────────────────────────────────────────────────
  if (document.querySelector('.niche-chip')) setActiveNiche(saved.nicheKey || '');

  // ── Load dynamic content ────────────────────────────────────────────────────
  loadQueue();
  loadLog();
  loadDashboard();

  // ══ Events ══════════════════════════════════════════════════════════════════

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab,.tab-content').forEach(el => el.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'log') loadLog();
      if (tab.dataset.tab === 'queue') loadQueue();
      if (tab.dataset.tab === 'dashboard') loadDashboard();
    });
  });

  // Gear → API Keys tab
  document.getElementById('gearBtn').addEventListener('click', () => {
    document.querySelectorAll('.tab,.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelector('[data-tab="apikeys"]').classList.add('active');
    document.getElementById('tab-apikeys').classList.add('active');
  });

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.sync.set({ theme: next });
    document.querySelectorAll('.theme-chip').forEach(c => c.classList.toggle('active', c.dataset.theme === next));
  });

  document.querySelectorAll('.theme-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const t = chip.dataset.theme;
      const resolved = t === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
      applyTheme(resolved);
      chrome.storage.sync.set({ theme: t });
      document.querySelectorAll('.theme-chip').forEach(c => c.classList.toggle('active', c.dataset.theme === t));
    });
  });

  // Provider selector
  document.querySelectorAll('.provider-btn').forEach(btn => btn.addEventListener('click', () => setActiveProvider(btn.dataset.provider)));

  // Eye buttons
  document.querySelectorAll('.eye-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Tone chips
  document.querySelectorAll('.tone-chip').forEach(chip => {
    chip.addEventListener('click', () => { document.querySelectorAll('.tone-chip').forEach(c => c.classList.remove('active')); chip.classList.add('active'); });
  });

  // Niche chips
  document.querySelectorAll('.niche-chip').forEach(chip => {
    chip.addEventListener('click', () => setActiveNiche(chip.dataset.niche));
  });

  // Save API keys → local storage
  document.getElementById('saveKeysBtn').addEventListener('click', async () => {
    const toSave = { activeProvider: document.querySelector('.provider-btn.active')?.dataset.provider || 'claude' };
    providers.forEach(p => { toSave[`apiKey_${p}`] = document.getElementById(`apiKey_${p}`)?.value.trim() || ''; });
    await chrome.storage.local.set(toSave);
    updateStatusDot(providers.some(p => toSave[`apiKey_${p}`]));
    showStatus('saveKeysStatus', '✓ Saved! Keys stored locally.', true);
  });

  // Save settings → sync storage
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const defaultTone   = document.querySelector('.tone-chip.active')?.dataset.tone || 'bigbrain';
    const autoOpenReply = document.getElementById('autoOpenReply').checked;
    const autoOpenPost  = document.getElementById('autoOpenPost').checked;
    const antiAI        = document.getElementById('antiAI').checked;
    const theme         = document.querySelector('.theme-chip.active')?.dataset.theme || 'dark';
    await chrome.storage.sync.set({ defaultTone, autoOpenReply, autoOpenPost, antiAI, theme });
    showStatus('saveSettingsStatus', '✓ Saved!', true);
  });

  // ── Persona Profiles ─────────────────────────────────────────────────────────
  let editingProfileId = null;

  async function loadProfiles() {
    const { personaProfiles = [], activeProfileId = null } = await chrome.storage.local.get(['personaProfiles','activeProfileId']);
    const listEl = document.getElementById('profileList');

    if (!personaProfiles.length) {
      listEl.innerHTML = '<div class="log-empty" style="font-size:11px;padding:8px 0">No profiles yet. Click "+ New" to create one.</div>';
      showProfileEditor(false);
      return;
    }

    listEl.innerHTML = personaProfiles.map(p => `
      <div class="profile-item ${p.id === activeProfileId ? 'profile-active' : ''}" data-id="${p.id}">
        <div class="profile-item-info">
          <span class="profile-item-name">${esc(p.name)}</span>
          ${p.nicheKey ? `<span class="profile-item-niche">${p.nicheKey}</span>` : ''}
        </div>
        <div class="profile-item-actions">
          <button class="profile-use-btn ${p.id === activeProfileId ? 'profile-use-active' : ''}" data-id="${p.id}">${p.id === activeProfileId ? '✓ Active' : 'Use'}</button>
          <button class="profile-edit-btn" data-id="${p.id}">Edit</button>
        </div>
      </div>`).join('');

    listEl.querySelectorAll('.profile-use-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { personaProfiles: ps = [] } = await chrome.storage.local.get(['personaProfiles']);
        const profile = ps.find(p => p.id === btn.dataset.id);
        if (!profile) return;
        await chrome.storage.local.set({ activeProfileId: profile.id });
        await chrome.storage.sync.set({ customPersona: profile.persona, topics: profile.topics, nicheKey: profile.nicheKey || '' });
      
  // ── AI Enhance Persona ───────────────────────────────────────────────────────
  document.getElementById('enhancePersonaBtn').addEventListener('click', async () => {
    const btn        = document.getElementById('enhancePersonaBtn');
    const statusEl   = document.getElementById('enhanceStatus');
    const textarea   = document.getElementById('customPersona');
    const topics     = document.getElementById('topics').value.trim();
    const nicheKey   = document.querySelector('.niche-chip.active')?.dataset.niche || '';
    const rawInput   = textarea.value.trim();

    if (!rawInput) {
      statusEl.textContent = 'Write a few words about yourself first, then enhance.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    // Get API key
    const saved = await chrome.storage.local.get(['activeProvider','apiKey_claude','apiKey_gemini','apiKey_openai','apiKey_grok','apiKey_groq']);
    const provider = saved.activeProvider || 'claude';
    const apiKey   = saved[`apiKey_${provider}`];
    if (!apiKey) {
      statusEl.textContent = 'No API key found — add one in the Keys tab.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="enhance-icon">⏳</span> Enhancing...';
    statusEl.textContent = '';
    statusEl.className = 'enhance-status';

    const nicheContext = {
      crypto: 'deep in crypto/web3 culture', saas: 'SaaS founder/operator space',
      fitness: 'fitness and gym culture', finance: 'finance and investing world',
      tech: 'tech and software industry', creator: 'content creator economy'
    }[nicheKey] || '';

    const systemPrompt = `You are an expert at writing AI persona prompts for social media reply bots.
Your job: take a rough, informal persona description and rewrite it into a clear, detailed, actionable persona prompt.
Output ONLY the enhanced persona text — no labels, no "here's your persona:", nothing else.`;

    const userPrompt = `Rewrite this rough persona description into a detailed, specific persona prompt (8-12 bullet points):

Raw input: "${rawInput}"
${topics ? `Topics they post about: ${topics}` : ''}
${nicheContext ? `Their niche: ${nicheContext}` : ''}

Write it as bullet points like:
- [specific voice trait]
- [specific content style]
- [specific things they say/don't say]
- [specific humor/tone details]
- [what makes them sound authentic and human]

Make it specific, vivid, and actionable. The AI should be able to read this and write tweets that sound exactly like this person.`;

    try {
      const ENDPOINTS = {
        claude:  { url: 'https://api.anthropic.com/v1/messages', call: async (key, sys, usr) => {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
            body: JSON.stringify({ model:'claude-opus-4-5', max_tokens:600, system:sys, messages:[{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).content?.[0]?.text?.trim();
        }},
        groq: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        openai: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'gpt-4o', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        gemini: { call: async (key, sys, usr) => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ system_instruction:{parts:[{text:sys}]}, contents:[{parts:[{text:usr}]}], generationConfig:{maxOutputTokens:600} })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        }},
        grok: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.x.ai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'grok-3-latest', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }}
      };

      const ep = ENDPOINTS[provider] || ENDPOINTS.claude;
      const enhanced = await ep.call(apiKey, systemPrompt, userPrompt);

      if (enhanced) {
        textarea.value = enhanced;
        statusEl.textContent = '✓ Persona enhanced! Review and save.';
        statusEl.className = 'enhance-status enhance-ok';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
      }
    } catch (err) {
      statusEl.textContent = `✗ ${err.message}`;
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="enhance-icon">✦</span> AI Enhance';
    }
  });

  loadProfiles();
        showStatus('savePersonaStatus', `✓ Switched to "${profile.name}"`, true);
      });
    });

    listEl.querySelectorAll('.profile-edit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { personaProfiles: ps = [] } = await chrome.storage.local.get(['personaProfiles']);
        const profile = ps.find(p => p.id === btn.dataset.id);
        if (!profile) return;
        editingProfileId = profile.id;
        document.getElementById('profileName').value = profile.name;
        document.getElementById('customPersona').value = profile.persona || '';
        document.getElementById('topics').value = profile.topics || '';
        setActiveNiche(profile.nicheKey || '');
        document.getElementById('delProfileBtn').style.display = 'inline-flex';
        showProfileEditor(true);
      });
    });
  }

  function showProfileEditor(show) {
    document.getElementById('profileEditor').style.display = show ? 'flex' : 'none';
  }

  document.getElementById('addProfileBtn').addEventListener('click', () => {
    editingProfileId = null;
    document.getElementById('profileName').value = '';
    document.getElementById('customPersona').value = '';
    document.getElementById('topics').value = '';
    setActiveNiche('');
    document.getElementById('delProfileBtn').style.display = 'none';
    showProfileEditor(true);
    document.getElementById('profileName').focus();
  });

  document.getElementById('savePersonaBtn').addEventListener('click', async () => {
    const name    = document.getElementById('profileName').value.trim();
    const persona = document.getElementById('customPersona').value.trim();
    const topics  = document.getElementById('topics').value.trim();
    const nicheKey = document.querySelector('.niche-chip.active')?.dataset.niche || '';

    if (!name) { showStatus('savePersonaStatus', 'Give your profile a name first', false); return; }

    const { personaProfiles = [], activeProfileId } = await chrome.storage.local.get(['personaProfiles','activeProfileId']);

    if (editingProfileId) {
      const idx = personaProfiles.findIndex(p => p.id === editingProfileId);
      if (idx >= 0) personaProfiles[idx] = { ...personaProfiles[idx], name, persona, topics, nicheKey };
    } else {
      const id = 'profile_' + Date.now();
      personaProfiles.push({ id, name, persona, topics, nicheKey });
      editingProfileId = id;
    }

    await chrome.storage.local.set({ personaProfiles });

    // If this is the active profile, update sync too
    const { activeProfileId: aid } = await chrome.storage.local.get(['activeProfileId']);
    if (aid === editingProfileId || !aid) {
      await chrome.storage.local.set({ activeProfileId: editingProfileId });
      await chrome.storage.sync.set({ customPersona: persona, topics, nicheKey });
    }

    document.getElementById('delProfileBtn').style.display = 'inline-flex';
    showStatus('savePersonaStatus', '✓ Profile saved!', true);
  
  // ── AI Enhance Persona ───────────────────────────────────────────────────────
  document.getElementById('enhancePersonaBtn').addEventListener('click', async () => {
    const btn        = document.getElementById('enhancePersonaBtn');
    const statusEl   = document.getElementById('enhanceStatus');
    const textarea   = document.getElementById('customPersona');
    const topics     = document.getElementById('topics').value.trim();
    const nicheKey   = document.querySelector('.niche-chip.active')?.dataset.niche || '';
    const rawInput   = textarea.value.trim();

    if (!rawInput) {
      statusEl.textContent = 'Write a few words about yourself first, then enhance.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    // Get API key
    const saved = await chrome.storage.local.get(['activeProvider','apiKey_claude','apiKey_gemini','apiKey_openai','apiKey_grok','apiKey_groq']);
    const provider = saved.activeProvider || 'claude';
    const apiKey   = saved[`apiKey_${provider}`];
    if (!apiKey) {
      statusEl.textContent = 'No API key found — add one in the Keys tab.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="enhance-icon">⏳</span> Enhancing...';
    statusEl.textContent = '';
    statusEl.className = 'enhance-status';

    const nicheContext = {
      crypto: 'deep in crypto/web3 culture', saas: 'SaaS founder/operator space',
      fitness: 'fitness and gym culture', finance: 'finance and investing world',
      tech: 'tech and software industry', creator: 'content creator economy'
    }[nicheKey] || '';

    const systemPrompt = `You are an expert at writing AI persona prompts for social media reply bots.
Your job: take a rough, informal persona description and rewrite it into a clear, detailed, actionable persona prompt.
Output ONLY the enhanced persona text — no labels, no "here's your persona:", nothing else.`;

    const userPrompt = `Rewrite this rough persona description into a detailed, specific persona prompt (8-12 bullet points):

Raw input: "${rawInput}"
${topics ? `Topics they post about: ${topics}` : ''}
${nicheContext ? `Their niche: ${nicheContext}` : ''}

Write it as bullet points like:
- [specific voice trait]
- [specific content style]
- [specific things they say/don't say]
- [specific humor/tone details]
- [what makes them sound authentic and human]

Make it specific, vivid, and actionable. The AI should be able to read this and write tweets that sound exactly like this person.`;

    try {
      const ENDPOINTS = {
        claude:  { url: 'https://api.anthropic.com/v1/messages', call: async (key, sys, usr) => {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
            body: JSON.stringify({ model:'claude-opus-4-5', max_tokens:600, system:sys, messages:[{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).content?.[0]?.text?.trim();
        }},
        groq: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        openai: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'gpt-4o', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        gemini: { call: async (key, sys, usr) => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ system_instruction:{parts:[{text:sys}]}, contents:[{parts:[{text:usr}]}], generationConfig:{maxOutputTokens:600} })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        }},
        grok: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.x.ai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'grok-3-latest', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }}
      };

      const ep = ENDPOINTS[provider] || ENDPOINTS.claude;
      const enhanced = await ep.call(apiKey, systemPrompt, userPrompt);

      if (enhanced) {
        textarea.value = enhanced;
        statusEl.textContent = '✓ Persona enhanced! Review and save.';
        statusEl.className = 'enhance-status enhance-ok';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
      }
    } catch (err) {
      statusEl.textContent = `✗ ${err.message}`;
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="enhance-icon">✦</span> AI Enhance';
    }
  });

  loadProfiles();
  });

  document.getElementById('delProfileBtn').addEventListener('click', async () => {
    if (!editingProfileId) return;
    const { personaProfiles = [] } = await chrome.storage.local.get(['personaProfiles']);
    const filtered = personaProfiles.filter(p => p.id !== editingProfileId);
    await chrome.storage.local.set({ personaProfiles: filtered });
    editingProfileId = null;
    showProfileEditor(false);
  
  // ── AI Enhance Persona ───────────────────────────────────────────────────────
  document.getElementById('enhancePersonaBtn').addEventListener('click', async () => {
    const btn        = document.getElementById('enhancePersonaBtn');
    const statusEl   = document.getElementById('enhanceStatus');
    const textarea   = document.getElementById('customPersona');
    const topics     = document.getElementById('topics').value.trim();
    const nicheKey   = document.querySelector('.niche-chip.active')?.dataset.niche || '';
    const rawInput   = textarea.value.trim();

    if (!rawInput) {
      statusEl.textContent = 'Write a few words about yourself first, then enhance.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    // Get API key
    const saved = await chrome.storage.local.get(['activeProvider','apiKey_claude','apiKey_gemini','apiKey_openai','apiKey_grok','apiKey_groq']);
    const provider = saved.activeProvider || 'claude';
    const apiKey   = saved[`apiKey_${provider}`];
    if (!apiKey) {
      statusEl.textContent = 'No API key found — add one in the Keys tab.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="enhance-icon">⏳</span> Enhancing...';
    statusEl.textContent = '';
    statusEl.className = 'enhance-status';

    const nicheContext = {
      crypto: 'deep in crypto/web3 culture', saas: 'SaaS founder/operator space',
      fitness: 'fitness and gym culture', finance: 'finance and investing world',
      tech: 'tech and software industry', creator: 'content creator economy'
    }[nicheKey] || '';

    const systemPrompt = `You are an expert at writing AI persona prompts for social media reply bots.
Your job: take a rough, informal persona description and rewrite it into a clear, detailed, actionable persona prompt.
Output ONLY the enhanced persona text — no labels, no "here's your persona:", nothing else.`;

    const userPrompt = `Rewrite this rough persona description into a detailed, specific persona prompt (8-12 bullet points):

Raw input: "${rawInput}"
${topics ? `Topics they post about: ${topics}` : ''}
${nicheContext ? `Their niche: ${nicheContext}` : ''}

Write it as bullet points like:
- [specific voice trait]
- [specific content style]
- [specific things they say/don't say]
- [specific humor/tone details]
- [what makes them sound authentic and human]

Make it specific, vivid, and actionable. The AI should be able to read this and write tweets that sound exactly like this person.`;

    try {
      const ENDPOINTS = {
        claude:  { url: 'https://api.anthropic.com/v1/messages', call: async (key, sys, usr) => {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
            body: JSON.stringify({ model:'claude-opus-4-5', max_tokens:600, system:sys, messages:[{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).content?.[0]?.text?.trim();
        }},
        groq: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        openai: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'gpt-4o', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        gemini: { call: async (key, sys, usr) => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ system_instruction:{parts:[{text:sys}]}, contents:[{parts:[{text:usr}]}], generationConfig:{maxOutputTokens:600} })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        }},
        grok: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.x.ai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'grok-3-latest', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }}
      };

      const ep = ENDPOINTS[provider] || ENDPOINTS.claude;
      const enhanced = await ep.call(apiKey, systemPrompt, userPrompt);

      if (enhanced) {
        textarea.value = enhanced;
        statusEl.textContent = '✓ Persona enhanced! Review and save.';
        statusEl.className = 'enhance-status enhance-ok';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
      }
    } catch (err) {
      statusEl.textContent = `✗ ${err.message}`;
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="enhance-icon">✦</span> AI Enhance';
    }
  });

  loadProfiles();
  });


  // ── AI Enhance Persona ───────────────────────────────────────────────────────
  document.getElementById('enhancePersonaBtn').addEventListener('click', async () => {
    const btn        = document.getElementById('enhancePersonaBtn');
    const statusEl   = document.getElementById('enhanceStatus');
    const textarea   = document.getElementById('customPersona');
    const topics     = document.getElementById('topics').value.trim();
    const nicheKey   = document.querySelector('.niche-chip.active')?.dataset.niche || '';
    const rawInput   = textarea.value.trim();

    if (!rawInput) {
      statusEl.textContent = 'Write a few words about yourself first, then enhance.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    // Get API key
    const saved = await chrome.storage.local.get(['activeProvider','apiKey_claude','apiKey_gemini','apiKey_openai','apiKey_grok','apiKey_groq']);
    const provider = saved.activeProvider || 'claude';
    const apiKey   = saved[`apiKey_${provider}`];
    if (!apiKey) {
      statusEl.textContent = 'No API key found — add one in the Keys tab.';
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 3000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="enhance-icon">⏳</span> Enhancing...';
    statusEl.textContent = '';
    statusEl.className = 'enhance-status';

    const nicheContext = {
      crypto: 'deep in crypto/web3 culture', saas: 'SaaS founder/operator space',
      fitness: 'fitness and gym culture', finance: 'finance and investing world',
      tech: 'tech and software industry', creator: 'content creator economy'
    }[nicheKey] || '';

    const systemPrompt = `You are an expert at writing AI persona prompts for social media reply bots.
Your job: take a rough, informal persona description and rewrite it into a clear, detailed, actionable persona prompt.
Output ONLY the enhanced persona text — no labels, no "here's your persona:", nothing else.`;

    const userPrompt = `Rewrite this rough persona description into a detailed, specific persona prompt (8-12 bullet points):

Raw input: "${rawInput}"
${topics ? `Topics they post about: ${topics}` : ''}
${nicheContext ? `Their niche: ${nicheContext}` : ''}

Write it as bullet points like:
- [specific voice trait]
- [specific content style]
- [specific things they say/don't say]
- [specific humor/tone details]
- [what makes them sound authentic and human]

Make it specific, vivid, and actionable. The AI should be able to read this and write tweets that sound exactly like this person.`;

    try {
      const ENDPOINTS = {
        claude:  { url: 'https://api.anthropic.com/v1/messages', call: async (key, sys, usr) => {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
            body: JSON.stringify({ model:'claude-opus-4-5', max_tokens:600, system:sys, messages:[{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).content?.[0]?.text?.trim();
        }},
        groq: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        openai: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'gpt-4o', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }},
        gemini: { call: async (key, sys, usr) => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ system_instruction:{parts:[{text:sys}]}, contents:[{parts:[{text:usr}]}], generationConfig:{maxOutputTokens:600} })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        }},
        grok: { call: async (key, sys, usr) => {
          const r = await fetch('https://api.x.ai/v1/chat/completions', {
            method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
            body: JSON.stringify({ model:'grok-3-latest', max_tokens:600, messages:[{role:'system',content:sys},{role:'user',content:usr}] })
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error?.message || `HTTP ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        }}
      };

      const ep = ENDPOINTS[provider] || ENDPOINTS.claude;
      const enhanced = await ep.call(apiKey, systemPrompt, userPrompt);

      if (enhanced) {
        textarea.value = enhanced;
        statusEl.textContent = '✓ Persona enhanced! Review and save.';
        statusEl.className = 'enhance-status enhance-ok';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
      }
    } catch (err) {
      statusEl.textContent = `✗ ${err.message}`;
      statusEl.className = 'enhance-status enhance-error';
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'enhance-status'; }, 4000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="enhance-icon">✦</span> AI Enhance';
    }
  });

  loadProfiles();

  // Queue: clear
  document.getElementById('clearQueue').addEventListener('click', async () => { await chrome.storage.local.set({ replyQueue: [] }); loadQueue(); });

  // Log: clear
  document.getElementById('clearLog').addEventListener('click', async () => { await chrome.storage.local.set({ replyLog: [] }); loadLog(); loadDashboard(); });

  // ══ Helpers ══════════════════════════════════════════════════════════════════

  function applyTheme(t) { document.documentElement.dataset.theme = t; }

  function setActiveProvider(p) {
    document.querySelectorAll('.provider-btn').forEach(b => b.classList.toggle('active', b.dataset.provider === p));
    document.querySelectorAll('.key-panel').forEach(panel => panel.classList.toggle('key-panel-active', panel.id === `key-${p}`));
  }

  function setActiveNiche(niche) {
    document.querySelectorAll('.niche-chip').forEach(c => c.classList.toggle('active', c.dataset.niche === niche));
  }

  function updateStatusDot(hasKey) {
    const dot = document.getElementById('statusDot');
    dot.className = 'status-dot ' + (hasKey ? 'status-ok' : 'status-missing');
  }

  function showStatus(id, msg, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = 'save-status ' + (ok ? 'status-success' : 'status-error');
    setTimeout(() => { el.textContent = ''; el.className = 'save-status'; }, 3000);
  }

  // ── Queue ───────────────────────────────────────────────────────────────────

  async function loadQueue() {
    const { replyQueue = [] } = await chrome.storage.local.get(['replyQueue']);
    const listEl  = document.getElementById('queueList');
    const countEl = document.getElementById('queueCount');
    const badge   = document.getElementById('queueBadge');
    const pending = replyQueue.filter(r => !r.sent);
    countEl.textContent = `${pending.length} repl${pending.length === 1 ? 'y' : 'ies'} queued`;
    if (pending.length > 0) { badge.style.display = 'inline'; badge.textContent = pending.length; }
    else badge.style.display = 'none';

    if (!replyQueue.length) { listEl.innerHTML = '<div class="log-empty">No replies queued. Hit "+ Queue" on any generated reply.</div>'; return; }

    listEl.innerHTML = [...replyQueue].reverse().map((item, ri) => {
      const idx = replyQueue.length - 1 - ri;
      const toneInfo = TONE_MAP[item.tone] || { emoji: '✦', color: '#888' };
      return `
        <div class="queue-item ${item.sent ? 'queue-sent' : ''}" data-idx="${idx}">
          <div class="queue-item-header">
            <span class="log-tone" style="color:${toneInfo.color}">${toneInfo.emoji} ${item.tone}</span>
            ${item.position ? `<span class="log-length-badge">#${item.position}</span>` : ''}
            <span class="log-time">${formatTime(item.ts)}</span>
          </div>
          <div class="queue-text">${esc(item.text)}</div>
          <div class="queue-actions">
            <button class="queue-copy" data-idx="${idx}">Copy</button>
            <button class="queue-mark ${item.sent ? 'queue-mark-done' : ''}" data-idx="${idx}">${item.sent ? '✓ Sent' : 'Mark sent'}</button>
            <button class="queue-del" data-idx="${idx}">✕</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.queue-copy').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { replyQueue: q = [] } = await chrome.storage.local.get(['replyQueue']);
        const idx = parseInt(btn.dataset.idx);
        navigator.clipboard.writeText(q[idx]?.text || '').then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); });
      });
    });

    listEl.querySelectorAll('.queue-mark').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { replyQueue: q = [] } = await chrome.storage.local.get(['replyQueue']);
        const idx = parseInt(btn.dataset.idx);
        if (q[idx]) { q[idx].sent = !q[idx].sent; await chrome.storage.local.set({ replyQueue: q }); loadQueue(); }
      });
    });

    listEl.querySelectorAll('.queue-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { replyQueue: q = [] } = await chrome.storage.local.get(['replyQueue']);
        const idx = parseInt(btn.dataset.idx);
        q.splice(idx, 1);
        await chrome.storage.local.set({ replyQueue: q }); loadQueue();
      });
    });
  }

  // ── Log ─────────────────────────────────────────────────────────────────────

  async function loadLog() {
    const { replyLog = [] } = await chrome.storage.local.get(['replyLog']);
    const listEl  = document.getElementById('logList');
    const countEl = document.getElementById('logCount');
    countEl.textContent = `${replyLog.length} repl${replyLog.length === 1 ? 'y' : 'ies'}`;

    if (!replyLog.length) { listEl.innerHTML = '<div class="log-empty">No replies yet.</div>'; return; }

    listEl.innerHTML = [...replyLog].reverse().map((entry, ri) => {
      const idx = replyLog.length - 1 - ri;
      const toneInfo = TONE_MAP[entry.tone] || { emoji: '✦', color: '#888' };
      return `
        <div class="log-entry">
          <div class="log-meta">
            <span class="log-tone" style="color:${toneInfo.color}">${toneInfo.emoji} ${entry.tone}</span>
            <span class="log-provider-badge">${entry.provider || 'claude'}</span>
            <span class="log-length-badge">${entry.length || 'medium'}</span>
            <span class="log-time">${formatTime(entry.ts)}</span>
            <button class="log-star ${entry.stars > 0 ? 'log-starred' : ''}" data-idx="${idx}" title="Star this reply">${entry.stars > 0 ? '⭐' : '☆'}</button>
          </div>
          ${entry.context ? `<div class="log-context">"${esc(entry.context.slice(0,90))}${entry.context.length>90?'…':''}"</div>` : ''}
          <div class="log-text">${esc(entry.text)}</div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.log-star').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { replyLog: log = [] } = await chrome.storage.local.get(['replyLog']);
        const idx = parseInt(btn.dataset.idx);
        if (log[idx]) { log[idx].stars = log[idx].stars > 0 ? 0 : 1; await chrome.storage.local.set({ replyLog: log }); loadLog(); loadDashboard(); }
      });
    });
  }

  // ── Dashboard ────────────────────────────────────────────────────────────────

  async function loadDashboard() {
    const { replyLog = [], usage = {} } = await chrome.storage.local.get(['replyLog','usage']);
    const today = new Date().toISOString().slice(0, 10);

    // Totals
    document.getElementById('dash-total').textContent = replyLog.length;
    const todayCount = replyLog.filter(r => r.ts && new Date(r.ts).toISOString().slice(0,10) === today).length;
    document.getElementById('dash-today').textContent = todayCount;

    // Cost estimate
    let totalCost = 0;
    Object.entries(usage).forEach(([provider, days]) => {
      const costPer1k = { claude: 0.015, openai: 0.005, gemini: 0.00035, grok: 0.01, groq: 0 }[provider] || 0;
      Object.values(days).forEach(d => { totalCost += (d.tokens / 1000) * costPer1k; });
    });
    document.getElementById('dash-cost').textContent = `$${totalCost.toFixed(3)}`;

    // Streak
    let streak = 0;
    const d = new Date();
    while (true) {
      const key = d.toISOString().slice(0, 10);
      const hasActivity = replyLog.some(r => r.ts && new Date(r.ts).toISOString().slice(0,10) === key);
      if (!hasActivity) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }
    document.getElementById('dash-streak').textContent = streak;

    // Tone bars
    const toneCounts = {};
    replyLog.forEach(r => { toneCounts[r.tone] = (toneCounts[r.tone] || 0) + 1; });
    const maxCount = Math.max(...Object.values(toneCounts), 1);
    const toneBarsEl = document.getElementById('toneBars');
    if (Object.keys(toneCounts).length === 0) { toneBarsEl.innerHTML = '<div class="log-empty" style="font-size:11px">No data yet.</div>'; }
    else {
      toneBarsEl.innerHTML = Object.entries(toneCounts).sort((a,b)=>b[1]-a[1]).map(([tone, count]) => {
        const info = TONE_MAP[tone] || { emoji: '✦', color: '#888' };
        const pct = Math.round((count / maxCount) * 100);
        return `<div class="tone-bar-row">
          <span class="tone-bar-label">${info.emoji} ${tone}</span>
          <div class="tone-bar-track"><div class="tone-bar-fill" style="width:${pct}%;background:${info.color}"></div></div>
          <span class="tone-bar-count">${count}</span>
        </div>`;
      }).join('');
    }

    // Starred
    const starred = replyLog.filter(r => r.stars > 0);
    const starredEl = document.getElementById('starredList');
    if (!starred.length) { starredEl.innerHTML = '<div class="log-empty" style="font-size:11px">No starred replies yet. Star replies in the Log tab.</div>'; }
    else {
      starredEl.innerHTML = starred.slice(-5).reverse().map(r => {
        const info = TONE_MAP[r.tone] || { emoji: '✦', color: '#888' };
        return `<div class="log-entry"><div class="log-meta"><span class="log-tone" style="color:${info.color}">${info.emoji} ${r.tone}</span><span class="log-time">${formatTime(r.ts)}</span></div><div class="log-text">${esc(r.text)}</div></div>`;
      }).join('');
    }
  }

  // ── Utils ────────────────────────────────────────────────────────────────────

  const TONE_MAP = { funny:{emoji:'😂',color:'#f59e0b'}, bigbrain:{emoji:'🧠',color:'#a855f7'}, knowledge:{emoji:'📚',color:'#22c55e'}, ragebait:{emoji:'🔥',color:'#ef4444'}, agree:{emoji:'🤝',color:'#3b82f6'}, thread:{emoji:'🧵',color:'#ec4899'}, flirt:{emoji:'😏',color:'#f43f5e'} };

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString([],{month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  }

  function esc(str='') { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

});
