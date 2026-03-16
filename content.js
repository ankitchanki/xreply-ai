// XReply AI v4 — Content Script

(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const TONES = [
    { id: 'funny',     emoji: '😂', label: 'Funny',       color: '#f59e0b' },
    { id: 'bigbrain',  emoji: '🧠', label: 'Big Brain',   color: '#a855f7' },
    { id: 'knowledge', emoji: '📚', label: 'Knowledge',   color: '#22c55e' },
    { id: 'ragebait',  emoji: '🔥', label: 'Ragebait',    color: '#ef4444' },
    { id: 'agree',     emoji: '🤝', label: 'Amplify',     color: '#3b82f6' },
    { id: 'thread',    emoji: '🧵', label: 'Thread Hook', color: '#ec4899' },
    { id: 'flirt',     emoji: '😏', label: 'Flirt',       color: '#f43f5e' },
  ];

  const LENGTHS = [
    { id: 'short', label: 'Short' },
    { id: 'medium', label: 'Medium' },
    { id: 'long', label: 'Long' },
  ];

  const MODES = { normal: 'normal', ab: 'ab', thread: 'thread', bulk: 'bulk' };

  // ─── State ─────────────────────────────────────────────────────────────────

  let activeTextarea   = null;
  let toolbar          = null;
  let floatingPill     = null;
  let isGenerating     = false;
  let activeTone       = 'bigbrain';
  let activeLength     = 'medium';
  let lastResult       = '';
  let autoVariantsDone = false;
  let cachedAnalysis   = null;
  let currentMode      = MODES.normal;
  let isPostBox        = false;  // true when compose type is 'post'
  let abToneA          = 'funny';
  let abToneB          = 'bigbrain';
  let undoTimer        = null;
  let lastInsertedText = '';

  // Draft memory — persist last result per page session
  const draftMemory = new Map();

  // ─── Thread Context Scraper ──────────────────────────────────────────────

  // ── Extract full text from a tweet article (includes links, hashtags, cashtags) ──
  function extractTweetText(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return '';
    // Get all text nodes + link texts (cashtags like $TRX, hashtags, URLs)
    let full = '';
    textEl.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        full += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Links: get visible text (hashtags, cashtags, mentions)
        full += node.innerText || node.textContent || '';
      }
    });
    return full.trim().slice(0, 500);
  }

  // ── Extract images from tweet article ──
  function extractTweetImages(article) {
    const imageEls = Array.from(article.querySelectorAll(
      '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img'
    ));
    return imageEls
      .map(img => img.src)
      .filter(src => src && src.includes('pbs.twimg.com/media'))
      .map(src => {
        try { const u = new URL(src); u.searchParams.set('format','jpg'); u.searchParams.set('name','medium'); return u.toString(); }
        catch { return src; }
      })
      .slice(0, 2);
  }

  // ── Extract author handle from tweet article ──
  function extractAuthor(article) {
    const handleEl = article.querySelector('[data-testid="User-Name"] a[href*="/"]');
    if (!handleEl) return 'user';
    const href = handleEl.getAttribute('href') || '';
    return href.replace(/^\//, '').split('/')[0] || 'user';
  }

  // ── Smart thread context scraper ──
  // Finds the tweet being replied to by walking UP from the compose box
  // This gives precise context rather than grabbing random timeline tweets
  function scrapeThreadContext(maxTweets = 3) {
    const tweets = [];
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (!articles.length) return tweets;

    // Strategy 1: Find the reply-to tweet by looking for the compose box parent
    // The tweet being replied to is typically the last visible article ABOVE the compose box
    let primaryArticle = null;

    if (activeTextarea) {
      // Walk up from compose box to find which tweet container we're inside
      let el = activeTextarea;
      for (let i = 0; i < 20; i++) {
        el = el?.parentElement;
        if (!el) break;
        // Check if any tweet article is a sibling or ancestor
        const siblingTweet = el.querySelector('article[data-testid="tweet"]');
        if (siblingTweet) { primaryArticle = siblingTweet; break; }
      }
    }

    // Strategy 2: If on a /status/ page, the first article is always the OP
    if (!primaryArticle && location.pathname.includes('/status/')) {
      primaryArticle = articles[0];
    }

    // Strategy 3: Fall back to last article (timeline reply scenario)
    if (!primaryArticle && articles.length > 0) {
      primaryArticle = articles[articles.length - 1];
    }

    if (primaryArticle) {
      const text   = extractTweetText(primaryArticle);
      const author = extractAuthor(primaryArticle);
      const images = extractTweetImages(primaryArticle);

      // Also get any card/link preview text (product titles etc)
      const cardTitle = primaryArticle.querySelector('[data-testid="card.layoutLarge.detail"] span, [data-testid="card.layoutSmall.detail"] span')?.innerText?.trim() || '';
      const fullText  = cardTitle ? `${text} [Link preview: ${cardTitle}]` : text;

      if (fullText || images.length) {
        tweets.push({ author, text: fullText.slice(0, 500), images, isPrimary: true });
      }

      // Get up to 2 parent tweets for thread context
      articles.forEach(article => {
        if (article === primaryArticle) return;
        const t = extractTweetText(article);
        const a = extractAuthor(article);
        if (t) tweets.push({ author: a, text: t.slice(0, 300), images: [], isPrimary: false });
      });
    }

    return tweets.slice(0, maxTweets);
  }

  // ─── Viral Tweet Scanner ─────────────────────────────────────────────────
  // Scans visible tweets for high engagement (replies + likes relative to age)

  function scanViralTweets() {
    const results = [];
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

    for (const article of articles) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      if (!textEl) continue;
      const text = textEl.innerText?.trim();
      if (!text) continue;

      // Parse engagement numbers
      const getCount = (testid) => {
        const el = article.querySelector(`[data-testid="${testid}"] span`);
        if (!el) return 0;
        const raw = el.innerText?.trim() || '0';
        if (raw.includes('K')) return parseFloat(raw) * 1000;
        if (raw.includes('M')) return parseFloat(raw) * 1000000;
        return parseInt(raw.replace(/,/g, '')) || 0;
      };

      const replies = getCount('reply');
      const likes   = getCount('like');
      const reposts = getCount('retweet');
      const score   = replies * 3 + likes + reposts * 2; // weight replies highest

      if (score < 100) continue; // minimum threshold

      const handleEl = article.querySelector('[data-testid="User-Name"] a[href*="/"]');
      let author = 'user';
      if (handleEl) { const href = handleEl.getAttribute('href') || ''; author = href.replace('/', '').split('/')[0] || 'user'; }

      results.push({ text: text.slice(0, 280), author, score, likes, replies, reposts, article });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  // ─── Clipboard Paste ─────────────────────────────────────────────────────

  function pasteIntoTwitter(textarea, text) {
    if (!textarea) return false;
    textarea.focus();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      if (textarea.innerText?.trim().includes(text.slice(0, 20))) return true;
    } catch (_) {}
    try {
      const range = document.createRange();
      range.selectNodeContents(textarea);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      const end = document.createRange();
      end.selectNodeContents(textarea);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
      return true;
    } catch (_) { return false; }
  }

  // ─── Undo Insert ────────────────────────────────────────────────────────

  function showUndoPill(textarea, previousText) {
    // Show undo inline inside the toolbar (after existing content), not floating
    clearTimeout(undoTimer);

    // Find or create a fresh toolbar just for the undo notification
    // Since toolbar is removed on insert, we inject a tiny inline bar
    const existing = document.getElementById('xreply-undo');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = 'xreply-undo';
    bar.innerHTML = `
      <span class="xr-undo-msg">✓ Reply inserted</span>
      <div class="xr-undo-progress"></div>
      <button class="xr-undo-btn">↩ Undo</button>
    `;

    // Insert it where the toolbar was — after toolBar test id
    let el = textarea;
    let inserted = false;
    for (let i = 0; i < 12; i++) {
      el = el?.parentElement;
      if (!el) break;
      const tb = el.querySelector('[data-testid="toolBar"]');
      if (tb) {
        tb.parentElement?.insertBefore(bar, tb.nextSibling);
        inserted = true;
        break;
      }
    }
    if (!inserted) textarea?.parentElement?.appendChild(bar);

    bar.querySelector('.xr-undo-btn').addEventListener('click', () => {
      clearTimeout(undoTimer);
      bar.remove();
      if (textarea) {
        textarea.focus();
        const range = document.createRange();
        range.selectNodeContents(textarea);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, previousText || '');
      }
    });

    // Auto-dismiss after 4s with progress bar animation
    bar.querySelector('.xr-undo-progress').style.animation = 'xr-undo-shrink 4s linear forwards';
    undoTimer = setTimeout(() => { bar.remove(); }, 4000);
  }

  // ─── Toolbar HTML ─────────────────────────────────────────────────────────

  function createToolbar() {
    const bar = document.createElement('div');
    bar.id = 'xreply-toolbar';
    bar.innerHTML = `
      <div class="xr-header">
        <span class="xr-logo">⚡ XReply AI</span>
        <div class="xr-header-right">
          <button class="xr-icon-btn xr-regen" title="Regenerate" style="display:none">↺</button>
          <button class="xr-icon-btn xr-ab-toggle" title="A/B compare two tones">A/B</button>
          <button class="xr-icon-btn xr-thread-toggle" title="Generate full thread">🧵</button>
          <button class="xr-icon-btn xr-close" title="Close">✕</button>
        </div>
      </div>

      <!-- Analysis badge -->
      <div class="xr-analysis-badge" style="display:none">
        <span class="xr-analysis-dot"></span>
        <span class="xr-analysis-text"></span>
      </div>

      <!-- Quick picks -->
      <div class="xr-variants-auto" style="display:none">
        <div class="xr-variants-label">Quick picks — tap to insert</div>
        <div class="xr-variant-cards"></div>
      </div>

      <!-- Divider -->
      <div class="xr-divider">Or choose a tone</div>

      <!-- Tone grid -->
      <div class="xr-tones">
        ${TONES.map(t => `
          <button class="xr-tone-btn" data-tone="${t.id}" style="--tone-color:${t.color}">
            <span>${t.emoji}</span>
            <span class="xr-tone-label">${t.label}</span>
          </button>`).join('')}
      </div>

      <!-- Length -->
      <div class="xr-lengths">
        ${LENGTHS.map((l, i) => `<button class="xr-len-btn${i===1?' xr-len-active':''}" data-len="${l.id}">${l.label}</button>`).join('')}
      </div>

      <!-- Loading -->
      <div class="xr-loading" style="display:none">
        <div class="xr-spinner"></div>
        <span class="xr-loading-text">Generating...</span>
      </div>

      <!-- Normal result -->
      <div class="xr-result" style="display:none">
        <div class="xr-result-badge"></div>
        <div class="xr-result-text" contenteditable="true" spellcheck="false"></div>
        <div class="xr-result-footer">
          <span class="xr-char-count"></span>
          <div class="xr-result-btns">
            <button class="xr-btn xr-queue-btn" title="Add to queue">+ Queue</button>
            <button class="xr-btn xr-copy-btn">Copy</button>
            <button class="xr-btn xr-insert-btn">Insert ↵</button>
          </div>
        </div>
      </div>

      <!-- A/B result -->
      <div class="xr-ab-result" style="display:none">
        <div class="xr-ab-picks">
          <div class="xr-ab-pick" id="xr-ab-a">
            <div class="xr-ab-selectors">
              ${TONES.map(t => `<button class="xr-ab-tone-sel" data-side="a" data-tone="${t.id}" style="--tone-color:${t.color}">${t.emoji}</button>`).join('')}
            </div>
            <div class="xr-ab-label xr-ab-label-a"></div>
            <div class="xr-ab-text" contenteditable="true" spellcheck="false"></div>
            <button class="xr-btn xr-ab-insert" data-side="a">Insert A ↵</button>
          </div>
          <div class="xr-ab-divider">VS</div>
          <div class="xr-ab-pick" id="xr-ab-b">
            <div class="xr-ab-selectors">
              ${TONES.map(t => `<button class="xr-ab-tone-sel" data-side="b" data-tone="${t.id}" style="--tone-color:${t.color}">${t.emoji}</button>`).join('')}
            </div>
            <div class="xr-ab-label xr-ab-label-b"></div>
            <div class="xr-ab-text" contenteditable="true" spellcheck="false"></div>
            <button class="xr-btn xr-ab-insert" data-side="b">Insert B ↵</button>
          </div>
        </div>
        <button class="xr-btn xr-ab-run" style="width:100%;margin-top:6px">⚡ Compare</button>
      </div>

      <!-- Thread result -->
      <div class="xr-thread-result" style="display:none">
        <div class="xr-thread-label">Thread preview — click tweet to copy</div>
        <div class="xr-thread-tweets"></div>
        <button class="xr-btn xr-thread-queue" style="width:100%;margin-top:6px">+ Add all to Queue</button>
      </div>

      <!-- Error -->
      <div class="xr-error" style="display:none"></div>
    `;
    return bar;
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  function attachEvents(bar) {
    bar.querySelector('.xr-close').addEventListener('click', removeToolbar);

    bar.querySelector('.xr-regen').addEventListener('click', () => generateWithTone(activeTone));

    // Mode toggles
    bar.querySelector('.xr-ab-toggle').addEventListener('click', () => {
      currentMode = currentMode === MODES.ab ? MODES.normal : MODES.ab;
      bar.querySelector('.xr-ab-toggle').classList.toggle('xr-mode-active', currentMode === MODES.ab);
      bar.querySelector('.xr-thread-toggle').classList.remove('xr-mode-active');
      if (currentMode === MODES.ab) {
        bar.querySelector('.xr-result').style.display = 'none';
        bar.querySelector('.xr-thread-result').style.display = 'none';
        bar.querySelector('.xr-ab-result').style.display = 'block';
        syncABSelectors();
      } else {
        bar.querySelector('.xr-ab-result').style.display = 'none';
      }
    });

    bar.querySelector('.xr-thread-toggle').addEventListener('click', () => {
      currentMode = currentMode === MODES.thread ? MODES.normal : MODES.thread;
      bar.querySelector('.xr-thread-toggle').classList.toggle('xr-mode-active', currentMode === MODES.thread);
      bar.querySelector('.xr-ab-toggle').classList.remove('xr-mode-active');
      if (currentMode === MODES.thread) {
        bar.querySelector('.xr-result').style.display = 'none';
        bar.querySelector('.xr-ab-result').style.display = 'none';
        bar.querySelector('.xr-thread-result').style.display = 'block';
        generateThread();
      } else {
        bar.querySelector('.xr-thread-result').style.display = 'none';
      }
    });

    // Tone buttons — clicking a tone always generates (cancels auto-variants if running)
    bar.querySelectorAll('.xr-tone-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Cancel any ongoing auto-generation so tone click always works
        isGenerating = false;
        autoVariantsDone = true; // prevent auto-variants from re-running

        activeTone = btn.dataset.tone;
        setActiveTone(activeTone);

        // Hide quick picks — user wants THIS specific tone, not suggestions
        const variantsWrap = bar.querySelector('.xr-variants-auto');
        if (variantsWrap) variantsWrap.style.display = 'none';

        if (currentMode === MODES.normal) generateWithTone(activeTone);
      });
    });

    // Length buttons
    bar.querySelectorAll('.xr-len-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeLength = btn.dataset.len;
        bar.querySelectorAll('.xr-len-btn').forEach(b => b.classList.remove('xr-len-active'));
        btn.classList.add('xr-len-active');
        if (lastResult) generateWithTone(activeTone);
      });
    });

    // Insert
    bar.querySelector('.xr-insert-btn').addEventListener('click', () => {
      const text = bar.querySelector('.xr-result-text').innerText?.trim();
      if (text && activeTextarea) {
        const prev = activeTextarea.innerText?.trim() || '';
        pasteIntoTwitter(activeTextarea, text);
        showUndoPill(activeTextarea, prev);
        saveToQueue(text, activeTone);
        removeToolbar();
      }
    });

    // Copy
    bar.querySelector('.xr-copy-btn').addEventListener('click', () => {
      const text = bar.querySelector('.xr-result-text').innerText?.trim();
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const btn = bar.querySelector('.xr-copy-btn');
        btn.textContent = 'Copied!'; btn.classList.add('xr-copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('xr-copied'); }, 2000);
      });
    });

    // Queue button
    bar.querySelector('.xr-queue-btn').addEventListener('click', () => {
      const text = bar.querySelector('.xr-result-text').innerText?.trim();
      if (text) {
        saveToQueue(text, activeTone);
        const btn = bar.querySelector('.xr-queue-btn');
        btn.textContent = '✓ Queued!'; btn.classList.add('xr-copied');
        setTimeout(() => { btn.textContent = '+ Queue'; btn.classList.remove('xr-copied'); }, 2000);
      }
    });

    // A/B tone selectors
    bar.querySelectorAll('.xr-ab-tone-sel').forEach(btn => {
      btn.addEventListener('click', () => {
        const side = btn.dataset.side;
        if (side === 'a') abToneA = btn.dataset.tone;
        else abToneB = btn.dataset.tone;
        syncABSelectors();
      });
    });

    // A/B run
    bar.querySelector('.xr-ab-run').addEventListener('click', runAB);

    // A/B insert
    bar.querySelectorAll('.xr-ab-insert').forEach(btn => {
      btn.addEventListener('click', () => {
        const side = btn.dataset.side;
        const textEl = bar.querySelector(`#xr-ab-${side} .xr-ab-text`);
        const text = textEl?.innerText?.trim();
        if (text && activeTextarea) {
          const prev = activeTextarea.innerText?.trim() || '';
          pasteIntoTwitter(activeTextarea, text);
          showUndoPill(activeTextarea, prev);
          removeToolbar();
        }
      });
    });

    // Thread queue all
    bar.querySelector('.xr-thread-queue').addEventListener('click', () => {
      const tweets = Array.from(bar.querySelectorAll('.xr-thread-tweet-text')).map(el => el.innerText?.trim()).filter(Boolean);
      tweets.forEach((t, i) => saveToQueue(t, 'thread', i + 1));
      const btn = bar.querySelector('.xr-thread-queue');
      btn.textContent = `✓ ${tweets.length} tweets queued!`;
      setTimeout(() => { btn.textContent = '+ Add all to Queue'; }, 2500);
    });
  }

  // ─── A/B Mode ────────────────────────────────────────────────────────────

  function syncABSelectors() {
    if (!toolbar) return;
    toolbar.querySelectorAll('.xr-ab-tone-sel[data-side="a"]').forEach(b => b.classList.toggle('xr-ab-sel-active', b.dataset.tone === abToneA));
    toolbar.querySelectorAll('.xr-ab-tone-sel[data-side="b"]').forEach(b => b.classList.toggle('xr-ab-sel-active', b.dataset.tone === abToneB));
    const toneA = TONES.find(t => t.id === abToneA);
    const toneB = TONES.find(t => t.id === abToneB);
    const labelA = toolbar.querySelector('.xr-ab-label-a');
    const labelB = toolbar.querySelector('.xr-ab-label-b');
    if (labelA) { labelA.textContent = `${toneA?.emoji} ${toneA?.label}`; labelA.style.color = toneA?.color || '#888'; }
    if (labelB) { labelB.textContent = `${toneB?.emoji} ${toneB?.label}`; labelB.style.color = toneB?.color || '#888'; }
  }

  async function runAB() {
    if (isGenerating || !toolbar) return;
    isGenerating = true;
    const runBtn = toolbar.querySelector('.xr-ab-run');
    runBtn.textContent = '⏳ Comparing...';
    runBtn.disabled = true;

    const threadContext = scrapeThreadContext();
    const draftText = activeTextarea?.innerText?.trim() || '';

    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'generateAB', tones: [abToneA, abToneB], threadContext, draftText, length: activeLength, tweetAnalysis: cachedAnalysis }, resolve);
    });

    isGenerating = false;
    runBtn.textContent = '⚡ Compare'; runBtn.disabled = false;

    if (!toolbar) return;
    if (response.error) { showError(response.error); return; }

    const setAB = (side, data) => {
      const textEl = toolbar.querySelector(`#xr-ab-${side} .xr-ab-text`);
      if (textEl) textEl.innerText = data.text || data.error || 'Failed';
    };
    setAB('a', response.a || {});
    setAB('b', response.b || {});
    syncABSelectors();
  }

  // ─── Thread Mode ──────────────────────────────────────────────────────────

  async function generateThread() {
    if (isGenerating || !toolbar) return;
    isGenerating = true;

    const threadResult = toolbar.querySelector('.xr-thread-result');
    const tweetsContainer = toolbar.querySelector('.xr-thread-tweets');
    tweetsContainer.innerHTML = '<div class="xr-variants-loading"><div class="xr-spinner"></div> Generating thread...</div>';

    const threadContext = scrapeThreadContext();
    const draftText = activeTextarea?.innerText?.trim() || '';

    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'generateThread', threadContext, draftText, topic: draftText, tweetAnalysis: cachedAnalysis }, resolve);
    });

    isGenerating = false;
    if (!toolbar) return;

    if (response.error) {
      tweetsContainer.innerHTML = `<div class="xr-variants-error">${response.error}</div>`;
      return;
    }

    tweetsContainer.innerHTML = '';
    response.tweets.forEach((text, i) => {
      const tweetEl = document.createElement('div');
      tweetEl.className = 'xr-thread-tweet';
      tweetEl.innerHTML = `<span class="xr-thread-num">${i + 1}</span><div class="xr-thread-tweet-text" contenteditable="true" spellcheck="false">${escapeHtml(text)}</div><div class="xr-thread-tweet-footer"><span class="xr-thread-char">${text.length}/280</span><button class="xr-thread-copy-btn">Copy</button></div>`;
      tweetEl.querySelector('.xr-thread-copy-btn').addEventListener('click', () => {
        const t = tweetEl.querySelector('.xr-thread-tweet-text').innerText?.trim();
        navigator.clipboard.writeText(t).then(() => {
          const btn = tweetEl.querySelector('.xr-thread-copy-btn');
          btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      });
      tweetsContainer.appendChild(tweetEl);
    });
  }

  // ─── Queue ────────────────────────────────────────────────────────────────

  async function saveToQueue(text, tone, position) {
    try {
      const { replyQueue = [] } = await chrome.storage.local.get(['replyQueue']);
      replyQueue.push({ text, tone, ts: Date.now(), position, sent: false, url: location.href });
      if (replyQueue.length > 50) replyQueue.splice(0, replyQueue.length - 50);
      await chrome.storage.local.set({ replyQueue });
      // Update badge
      chrome.runtime.sendMessage({ action: 'trackUsage', provider: '', tokens: 0 });
    } catch (_) {}
  }

  // ─── Auto-variants ────────────────────────────────────────────────────────

  async function autoGenerateVariants() {
    if (autoVariantsDone || !toolbar) return;
    autoVariantsDone = true;

    const settings = await new Promise(r => chrome.runtime.sendMessage({ action: 'getSettings' }, r));
    const provider = settings?.activeProvider || 'claude';
    const hasKey = settings?.[`apiKey_${provider}`] || settings?.apiKey_claude || settings?.apiKey_groq;
    if (!hasKey) return;

    const threadContext = scrapeThreadContext();
    const draftText = activeTextarea?.innerText?.trim() || '';

    // Check draft memory
    const memKey = `${location.href}:${draftText.slice(0, 50)}`;
    if (draftMemory.has(memKey)) {
      const cached = draftMemory.get(memKey);
      renderVariantCards(cached.variants, threadContext, draftText);
      if (cached.analysis) { cachedAnalysis = cached.analysis; showAnalysisBadge(cached.analysis); }
      return;
    }

    const wrap = toolbar.querySelector('.xr-variants-auto');
    wrap.style.display = 'block';
    const hasImages = threadContext.some(t => t.images?.length > 0);
    wrap.querySelector('.xr-variant-cards').innerHTML = `<div class="xr-variants-loading"><div class="xr-spinner"></div><span>${hasImages ? 'Reading tweet & images...' : 'Understanding tweet...'}</span></div>`;

    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'generateVariants', threadContext, draftText, tones: ['funny', 'bigbrain', 'agree'] }, resolve);
    });

    if (!toolbar) return;
    if (response.error) { wrap.querySelector('.xr-variant-cards').innerHTML = `<div class="xr-variants-error">${escapeHtml(response.error)}</div>`; return; }

    if (response.tweetAnalysis) {
      cachedAnalysis = response.tweetAnalysis;
      showAnalysisBadge(response.tweetAnalysis);
    }

    draftMemory.set(memKey, { variants: response.variants, analysis: response.tweetAnalysis });
    renderVariantCards(response.variants || [], threadContext, draftText);
  }

  function showAnalysisBadge(analysis) {
    if (!toolbar || !analysis?.topic) return;
    const badge = toolbar.querySelector('.xr-analysis-badge');
    const textEl = toolbar.querySelector('.xr-analysis-text');
    if (!badge || !textEl) return;
    textEl.innerHTML = `<strong>${escapeHtml(analysis.topic)}</strong> · ${escapeHtml(analysis.intent || '')}`;
    badge.style.display = 'flex';
  }

  function renderVariantCards(variants, threadContext, draftText) {
    if (!toolbar) return;
    const container = toolbar.querySelector('.xr-variant-cards');
    const wrap      = toolbar.querySelector('.xr-variants-auto');
    if (!container) return;
    container.innerHTML = '';
    const successful = variants.filter(v => v.text);
    if (!successful.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    successful.forEach(({ tone, text }) => appendVariantCard(container, tone, text, threadContext, draftText));
  }

  function appendVariantCard(container, tone, text, threadContext, draftText) {
    const toneInfo = TONES.find(t => t.id === tone);
    const card = document.createElement('div');
    card.className = 'xr-variant-card';
    card.dataset.tone = tone;
    card.innerHTML = `
      <div class="xr-variant-header">
        <div class="xr-variant-tone" style="--tone-color:${toneInfo?.color||'#888'}">${toneInfo?.emoji||''} ${toneInfo?.label||tone}</div>
        <div class="xr-variant-card-actions">
          <button class="xr-variant-queue" title="Add to queue">+Q</button>
          <button class="xr-variant-dismiss" title="Get different suggestion">✕</button>
        </div>
      </div>
      <div class="xr-variant-preview">${escapeHtml(text)}</div>`;

    card.querySelector('.xr-variant-preview').addEventListener('click', () => {
      if (activeTextarea) {
        const prev = activeTextarea.innerText?.trim() || '';
        pasteIntoTwitter(activeTextarea, text);
        showUndoPill(activeTextarea, prev);
        removeToolbar();
      }
    });
    card.querySelector('.xr-variant-queue').addEventListener('click', (e) => {
      e.stopPropagation();
      saveToQueue(text, tone);
      const btn = card.querySelector('.xr-variant-queue');
      btn.textContent = '✓'; setTimeout(() => { btn.textContent = '+Q'; }, 1500);
    });
    card.querySelector('.xr-variant-dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
      dismissAndReplace(card, tone, container, threadContext, draftText);
    });
    container.appendChild(card);
  }

  async function dismissAndReplace(card, tone, container, threadContext, draftText) {
    card.classList.add('xr-card-dismissing');
    const skeleton = document.createElement('div');
    skeleton.className = 'xr-variant-skeleton';
    const toneInfo = TONES.find(t => t.id === tone);
    skeleton.innerHTML = `<div class="xr-variant-tone" style="--tone-color:${toneInfo?.color||'#888'}">${toneInfo?.emoji||''} ${toneInfo?.label||tone}</div><div class="xr-skeleton-line"></div><div class="xr-skeleton-line xr-skeleton-short"></div>`;
    setTimeout(() => { card.replaceWith(skeleton); }, 200);
    const response = await new Promise(resolve => { chrome.runtime.sendMessage({ action: 'regenerateVariant', tone, threadContext, draftText, tweetAnalysis: cachedAnalysis }, resolve); });
    if (!toolbar) return;
    skeleton.remove();
    if (response?.text) appendVariantCard(container, tone, response.text, threadContext, draftText);
  }


  // ─── Auto-generate post ideas (for "What's happening?" box) ──────────────
  // Runs when user has a persona set and clicks the post compose box

  async function autoGeneratePostIdeas() {
    if (autoVariantsDone || !toolbar) return;
    autoVariantsDone = true;

    const settings = await new Promise(r => chrome.runtime.sendMessage({ action: 'getSettings' }, r));
    const provider  = settings?.activeProvider || 'claude';
    const hasKey    = settings?.[`apiKey_${provider}`] || settings?.apiKey_groq || settings?.apiKey_claude;
    if (!hasKey) return;

    // Only run if persona is set — otherwise not useful
    const hasPersona = settings?.customPersona || settings?.topics || settings?.nicheKey;
    if (!hasPersona) return;

    const draftText = activeTextarea?.innerText?.trim() || '';

    const wrap = toolbar.querySelector('.xr-variants-auto');
    const label = toolbar.querySelector('.xr-variants-label');
    wrap.style.display = 'block';
    if (label) label.textContent = 'Post ideas for you — tap to insert';
    wrap.querySelector('.xr-variant-cards').innerHTML =
      `<div class="xr-variants-loading"><div class="xr-spinner"></div><span>Generating ideas from your persona...</span></div>`;

    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'generatePostIdeas', draftText }, resolve);
    });

    if (!toolbar) return;

    if (response.error) {
      wrap.querySelector('.xr-variant-cards').innerHTML = `<div class="xr-variants-error">${escapeHtml(response.error)}</div>`;
      return;
    }

    const container = wrap.querySelector('.xr-variant-cards');
    container.innerHTML = '';

    (response.ideas || []).forEach((text, i) => {
      const tones   = ['bigbrain','agree','ragebait'];
      const toneId  = tones[i] || 'bigbrain';
      const toneInfo = TONES.find(t => t.id === toneId);
      const card = document.createElement('div');
      card.className = 'xr-variant-card xr-post-idea-card';
      card.innerHTML = `
        <div class="xr-variant-header">
          <div class="xr-post-idea-num" style="color:${toneInfo?.color||'#888'}">Idea ${i+1}</div>
          <div class="xr-variant-card-actions">
            <button class="xr-variant-queue" title="Save to queue">+Q</button>
            <button class="xr-variant-dismiss" title="Get different idea">✕</button>
          </div>
        </div>
        <div class="xr-variant-preview">${escapeHtml(text)}</div>
        <div class="xr-post-char">${text.length}/280</div>
      `;

      card.querySelector('.xr-variant-preview').addEventListener('click', () => {
        if (activeTextarea) {
          const prev = activeTextarea.innerText?.trim() || '';
          pasteIntoTwitter(activeTextarea, text);
          showUndoPill(activeTextarea, prev);
          removeToolbar();
        }
      });

      card.querySelector('.xr-variant-queue').addEventListener('click', (e) => {
        e.stopPropagation();
        saveToQueue(text, 'post');
        const btn = card.querySelector('.xr-variant-queue');
        btn.textContent = '✓'; setTimeout(() => { btn.textContent = '+Q'; }, 1500);
      });

      card.querySelector('.xr-variant-dismiss').addEventListener('click', async (e) => {
        e.stopPropagation();
        card.classList.add('xr-card-dismissing');
        const skeleton = document.createElement('div');
        skeleton.className = 'xr-variant-skeleton';
        skeleton.innerHTML = `<div class="xr-skeleton-line"></div><div class="xr-skeleton-line xr-skeleton-short"></div>`;
        setTimeout(() => { card.replaceWith(skeleton); }, 200);

        const resp = await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: 'generatePostIdeas', draftText: '' }, resolve);
        });
        if (!toolbar) return;
        skeleton.remove();

        if (resp?.ideas?.length) {
          const newText = resp.ideas[0];
          const newCard = document.createElement('div');
          newCard.className = 'xr-variant-card xr-post-idea-card';
          newCard.innerHTML = `<div class="xr-variant-header"><div class="xr-post-idea-num" style="color:${toneInfo?.color||'#888'}">Idea ${i+1}</div><div class="xr-variant-card-actions"><button class="xr-variant-queue">+Q</button><button class="xr-variant-dismiss">✕</button></div></div><div class="xr-variant-preview">${escapeHtml(newText)}</div><div class="xr-post-char">${newText.length}/280</div>`;
          newCard.querySelector('.xr-variant-preview').addEventListener('click', () => {
            if (activeTextarea) { pasteIntoTwitter(activeTextarea, newText); removeToolbar(); }
          });
          container.appendChild(newCard);
        }
      });

      container.appendChild(card);
    });
  }

  // ─── Generate with tone ───────────────────────────────────────────────────

  async function generateWithTone(tone) {
    if (isGenerating || !toolbar) return;
    isGenerating = true;
    setActiveTone(tone);
    showLoading(true);
    hideResult(); hideError();

    const settings = await new Promise(r => chrome.runtime.sendMessage({ action: 'getSettings' }, r));
    const provider = settings?.activeProvider || 'claude';
    const hasKey = settings?.[`apiKey_${provider}`];

    if (!hasKey) {
      showError('No API key. Open XReply AI → API Keys tab.'); showLoading(false); isGenerating = false; return;
    }

    const threadContext = scrapeThreadContext();
    const draftText = activeTextarea?.innerText?.trim() || '';

    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'generateReply', tone, length: activeLength, threadContext, draftText, tweetAnalysis: cachedAnalysis }, resolve);
    });

    showLoading(false); isGenerating = false;
    if (!toolbar) return;
    if (response.error) { showError(response.error); return; }

    lastResult = response.text;
    // Save draft memory
    const memKey = `${location.href}:tone:${tone}`;
    draftMemory.set(memKey, { text: response.text });

    showResult(response.text, tone);
    toolbar.querySelector('.xr-regen').style.display = 'flex';
  }

  // ─── UI helpers ──────────────────────────────────────────────────────────

  function setActiveTone(tone) {
    if (!toolbar) return;
    toolbar.querySelectorAll('.xr-tone-btn').forEach(b => b.classList.toggle('xr-tone-active', b.dataset.tone === tone));
  }

  function showLoading(on) { if (!toolbar) return; toolbar.querySelector('.xr-loading').style.display = on ? 'flex' : 'none'; }
  function hideResult()    { if (!toolbar) return; toolbar.querySelector('.xr-result').style.display = 'none'; }
  function hideError()     { if (!toolbar) return; toolbar.querySelector('.xr-error').style.display = 'none'; }

  function showResult(text, tone) {
    if (!toolbar) return;
    // Hide quick picks when showing a specific tone result
    const variantsWrap = toolbar.querySelector('.xr-variants-auto');
    if (variantsWrap) variantsWrap.style.display = 'none';
    const resultEl = toolbar.querySelector('.xr-result');
    const textEl   = toolbar.querySelector('.xr-result-text');
    const charEl   = toolbar.querySelector('.xr-char-count');
    const badgeEl  = toolbar.querySelector('.xr-result-badge');
    const toneInfo = TONES.find(t => t.id === tone);
    textEl.innerText = text;
    charEl.textContent = `${text.length}/280`;
    charEl.className = 'xr-char-count' + (text.length > 280 ? ' xr-over' : '');
    badgeEl.style.setProperty('--tone-color', toneInfo?.color || '#888');
    badgeEl.textContent = `${toneInfo?.emoji||''} ${toneInfo?.label||tone} · ${LENGTHS.find(l=>l.id===activeLength)?.label||''}`;
    resultEl.style.display = 'block';
  }

  function showError(msg) {
    if (!toolbar) return;
    showLoading(false);
    const el = toolbar.querySelector('.xr-error');
    el.textContent = msg; el.style.display = 'block'; isGenerating = false;
  }

  function escapeHtml(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ─── Toolbar lifecycle ────────────────────────────────────────────────────

  function injectToolbar(textarea, runAutoVariants = true) {
    if (toolbar && activeTextarea === textarea) return;
    removeToolbar(); removePill();
    activeTextarea = textarea;
    autoVariantsDone = false;
    lastResult = '';
    cachedAnalysis = null;
    currentMode = MODES.normal;
    activeTone = 'bigbrain';
    activeLength = 'medium';

    toolbar = createToolbar();
    attachEvents(toolbar);
    syncABSelectors();

    let el = textarea; let inserted = false;
    for (let i = 0; i < 12; i++) {
      el = el?.parentElement; if (!el) break;
      const tb = el.querySelector('[data-testid="toolBar"]');
      if (tb) { tb.parentElement?.insertBefore(toolbar, tb.nextSibling); inserted = true; break; }
    }
    if (!inserted) textarea.parentElement?.appendChild(toolbar);

    if (runAutoVariants) setTimeout(autoGenerateVariants, 100);
  }

  function removeToolbar() {
    toolbar?.remove(); toolbar = null;
    activeTextarea = null; isGenerating = false;
    autoVariantsDone = false; lastResult = '';
    cachedAnalysis = null; currentMode = MODES.normal;
  }

  function removePill() { floatingPill?.remove(); floatingPill = null; }

  // ─── Floating Pill ───────────────────────────────────────────────────────

  function createFloatingPill(textarea) {
    removePill();
    const pill = document.createElement('button');
    pill.id = 'xreply-pill';
    pill.innerHTML = `<span class="xr-pill-icon">⚡</span><span class="xr-pill-text">AI Reply</span>`;
    pill.title = 'Open XReply AI (or Alt+X)';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      removePill();
      const type = getComposeType(textarea);
      if (type === 'post') {
        isPostBox = true;
        injectToolbar(textarea, false);
        setTimeout(autoGeneratePostIdeas, 100);
      } else {
        isPostBox = false;
        injectToolbar(textarea, true);
      }
    });

    let el = textarea; let inserted = false;
    for (let i = 0; i < 12; i++) {
      el = el?.parentElement; if (!el) break;
      const tb = el.querySelector('[data-testid="toolBar"]');
      if (tb) {
        const wrapper = document.createElement('div');
        wrapper.className = 'xr-pill-wrapper';
        wrapper.appendChild(pill);
        tb.parentElement?.insertBefore(wrapper, tb.nextSibling);
        inserted = true; break;
      }
    }
    if (!inserted) textarea.parentElement?.appendChild(pill);
    floatingPill = pill.closest('.xr-pill-wrapper') || pill;
  }

  // ─── Focus detection ──────────────────────────────────────────────────────

  function getComposeType(target) {
    if (!target?.getAttribute) return null;
    if (target.getAttribute('contenteditable') !== 'true') return null;
    const testid = target.getAttribute('data-testid') || '';
    if (!testid.includes('tweetTextarea') && !testid.includes('tweetText') && !target.closest?.('[data-testid="tweetTextarea_0"]')) return null;
    const hasParentTweet = !!document.querySelector('[data-testid="tweet"] [data-testid="tweetText"]');
    return (location.pathname.includes('/status/') || hasParentTweet) ? 'reply' : 'post';
  }

  function getTextareaFromTarget(target) {
    if (!target) return null;
    const testid = target.getAttribute?.('data-testid') || '';
    if (target.getAttribute?.('contenteditable') === 'true' && (testid.includes('tweetTextarea') || testid.includes('tweetText'))) return target;
    const composable = target.closest?.('[contenteditable="true"]');
    if (composable) { const cid = composable.getAttribute?.('data-testid') || ''; if (cid.includes('tweetTextarea') || cid.includes('tweetText')) return composable; }
    return null;
  }

  document.addEventListener('focusin', async (e) => {
    const textarea = getTextareaFromTarget(e.target);
    if (!textarea) return;
    if (activeTextarea === textarea && (toolbar || floatingPill)) return;

    const settings = await new Promise(r => chrome.runtime.sendMessage({ action: 'getSettings' }, r));
    const composeType = getComposeType(textarea);

    if (composeType === 'reply') {
      const autoReply = settings?.autoOpenReply !== false;
      setTimeout(() => {
        if (autoReply) {
          isPostBox = false;
          injectToolbar(textarea, true);    // run autoGenerateVariants
        } else {
          createFloatingPill(textarea);
        }
      }, 120);
    } else {
      // Post box — show ideas based on persona
      const autoPost  = settings?.autoOpenPost === true;
      const hasPersona = settings?.customPersona || settings?.topics || settings?.nicheKey;
      setTimeout(() => {
        if (autoPost || hasPersona) {
          isPostBox = true;
          injectToolbar(textarea, false);   // don't run autoGenerateVariants
          setTimeout(autoGeneratePostIdeas, 100);  // run post ideas instead
        } else {
          createFloatingPill(textarea);
        }
      }, 120);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'x') {
      e.preventDefault();
      const textarea = getTextareaFromTarget(document.activeElement);
      if (textarea) { removePill(); toolbar && activeTextarea === textarea ? removeToolbar() : injectToolbar(textarea, true); }
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (toolbar?.contains(e.target)) e.stopPropagation();
    if (floatingPill && !floatingPill.contains(e.target)) removePill();
  }, true);

  // SPA navigation cleanup
  let lastUrl = location.href;
  new MutationObserver(() => { if (location.href !== lastUrl) { lastUrl = location.href; removeToolbar(); } }).observe(document.body, { childList: true, subtree: true });

})();
