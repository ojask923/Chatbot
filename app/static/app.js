/**
 * Local AI Chatbot - Frontend Logic & SSE Streaming
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentSessionId = localStorage.getItem('active_session_id') || createNewSessionId();
  let sessions = JSON.parse(localStorage.getItem('chat_sessions') || '[]');
  let isGenerating = false;
  let abortController = null;

  // Settings State
  const savedProvider = localStorage.getItem('cfg_provider');
  const initialProvider = (savedProvider && savedProvider !== 'mock') ? savedProvider : 'groq';
  const savedModel = localStorage.getItem('cfg_model');
  const initialModel = (savedModel && savedModel !== 'demo-assistant') ? savedModel : 'openai/gpt-oss-120b';

  let config = {
    provider: initialProvider,
    model: initialModel,
    temperature: parseFloat(localStorage.getItem('cfg_temp') || '0.7'),
    systemPrompt: localStorage.getItem('cfg_system_prompt') || '',
  };

  // DOM Elements
  const messagesContainer = document.getElementById('chat-messages');
  const welcomeHero = document.getElementById('welcome-hero');
  const userInput = document.getElementById('user-input');
  const chatForm = document.getElementById('chat-form');
  const sendBtn = document.getElementById('send-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const sessionsList = document.getElementById('sessions-list');
  const clearChatBtn = document.getElementById('clear-chat-btn');
  const exportChatBtn = document.getElementById('export-chat-btn');
  const voiceBtn = document.getElementById('voice-input-btn');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const themeIcon = document.getElementById('theme-icon');
  const themeText = document.getElementById('theme-text');
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');

  // Header and Settings Elements
  const activeModelPill = document.getElementById('active-model-pill');
  const headerProviderName = document.getElementById('header-provider-name');
  const headerModelName = document.getElementById('header-model-name');
  const settingsModal = document.getElementById('settings-modal');
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const providerSelect = document.getElementById('provider-select');
  const providerDesc = document.getElementById('provider-desc');
  const modelInput = document.getElementById('model-input');
  const tempSlider = document.getElementById('temp-slider');
  const tempVal = document.getElementById('temp-val');
  const systemPromptInput = document.getElementById('system-prompt');

  // Provider Default Model Mapping
  const providerDefaults = {
    groq: { model: 'openai/gpt-oss-120b', desc: 'Groq ultra-fast GPT-OSS 120B / Qwen 3.8 (configured via GROQ_API_KEY in .env).' },
    ollama: { model: 'llama3.2', desc: '100% Free local models running via Ollama on your computer.' },
    openai: { model: 'gpt-4o-mini', desc: 'OpenAI GPT-4o models (requires OPENAI_API_KEY in .env).' },
    gemini: { model: 'gemini-1.5-flash', desc: 'Google Gemini Flash / Pro (requires GEMINI_API_KEY in .env).' },
    anthropic: { model: 'claude-3-5-sonnet-20241022', desc: 'Anthropic Claude models (requires ANTHROPIC_API_KEY in .env).' },
  };

  // Initialize
  initTheme();
  updateHeaderPill();
  fetchSessions();
  loadSessionHistory(currentSessionId);
  setupAutoResize();

  // Event Listeners
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSendMessage();
  });

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  newChatBtn.addEventListener('click', () => {
    startNewChat();
  });

  clearChatBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear this conversation?')) {
      await fetch(`/api/history/${currentSessionId}`, { method: 'DELETE' });
      messagesContainer.innerHTML = '';
      messagesContainer.appendChild(welcomeHero);
      welcomeHero.style.display = 'flex';
    }
  });

  exportChatBtn.addEventListener('click', exportConversation);

  // Suggestion chips
  document.querySelectorAll('.suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      userInput.value = prompt;
      handleSendMessage();
    });
  });

  // Settings Modal Events
  activeModelPill.addEventListener('click', openSettings);
  openSettingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  providerSelect.addEventListener('change', () => {
    const selected = providerSelect.value;
    if (providerDefaults[selected]) {
      modelInput.value = providerDefaults[selected].model;
      providerDesc.textContent = providerDefaults[selected].desc;
    }
  });

  tempSlider.addEventListener('input', () => {
    tempVal.textContent = tempSlider.value;
  });

  saveSettingsBtn.addEventListener('click', () => {
    config.provider = providerSelect.value;
    config.model = modelInput.value.trim() || providerDefaults[config.provider].model;
    config.temperature = parseFloat(tempSlider.value);
    config.systemPrompt = systemPromptInput.value.trim();

    localStorage.setItem('cfg_provider', config.provider);
    localStorage.setItem('cfg_model', config.model);
    localStorage.setItem('cfg_temp', config.temperature.toString());
    localStorage.setItem('cfg_system_prompt', config.systemPrompt);

    updateHeaderPill();
    closeSettings();
  });

  // Theme Toggle
  themeToggleBtn.addEventListener('click', toggleTheme);

  // Mobile sidebar toggle
  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  // Voice Input (Speech-to-Text)
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;

    voiceBtn.addEventListener('click', () => {
      recognition.start();
      voiceBtn.style.color = '#ef4444';
    });

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      userInput.value = transcript;
      voiceBtn.style.color = '';
      handleSendMessage();
    };

    recognition.onerror = () => {
      voiceBtn.style.color = '';
    };

    recognition.onend = () => {
      voiceBtn.style.color = '';
    };
  } else {
    voiceBtn.style.display = 'none';
  }

  // -------------------------------------------------------------
  // Messaging & Streaming Engine
  // -------------------------------------------------------------
  async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text || isGenerating) return;

    // Reset textarea
    userInput.value = '';
    userInput.style.height = 'auto';

    // Hide welcome hero if visible
    if (welcomeHero && welcomeHero.parentElement) {
      welcomeHero.style.display = 'none';
    }

    // Save session title if new
    ensureSessionExists(text);

    // Append User Message to UI
    appendMessageUI('user', text);

    // Prepare Assistant Message Placeholder with live cursor
    const { bubbleEl, toolContainerEl, rowEl } = createAssistantMessageUI();
    isGenerating = true;
    sendBtn.disabled = true;

    let fullAssistantResponse = '';
    abortController = new AbortController();

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: currentSessionId,
          provider: config.provider,
          model: config.model,
          system_prompt: config.systemPrompt || undefined,
          temperature: config.temperature,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep partial line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            if (!dataStr) continue;

            try {
              const event = JSON.parse(dataStr);
              if (event.type === 'token') {
                fullAssistantResponse += event.content;
                renderAssistantMarkdown(bubbleEl, fullAssistantResponse, true);
                scrollToBottom();
              } else if (event.type === 'tool_start') {
                renderToolBadge(toolContainerEl, event.name, 'running', event.args);
              } else if (event.type === 'tool_end') {
                renderToolBadge(toolContainerEl, event.name, 'done', null, event.result);
              } else if (event.type === 'error') {
                fullAssistantResponse += `\n\n⚠️ **Error:** ${event.content}`;
                renderAssistantMarkdown(bubbleEl, fullAssistantResponse, false);
              } else if (event.type === 'done') {
                // finished
              }
            } catch (err) {
              console.error('SSE JSON parse error:', err, dataStr);
            }
          }
        }
      }

      // Finalize Markdown formatting
      renderAssistantMarkdown(bubbleEl, fullAssistantResponse, false);
      highlightCodeBlocks(bubbleEl);
    } catch (err) {
      if (err.name !== 'AbortError') {
        renderAssistantMarkdown(bubbleEl, `⚠️ **Connection Error:** ${err.message}`, false);
      }
    } finally {
      isGenerating = false;
      sendBtn.disabled = false;
      scrollToBottom();
    }
  }

  // -------------------------------------------------------------
  // UI Rendering Helpers
  // -------------------------------------------------------------
  function appendMessageUI(role, content) {
    const row = document.createElement('div');
    row.className = `message-row ${role === 'user' ? 'user-row' : 'bot-row'}`;

    const avatar = document.createElement('div');
    avatar.className = `message-avatar ${role === 'user' ? 'user-avatar' : 'bot-avatar'}`;
    avatar.textContent = role === 'user' ? '👤' : '⚡';

    const wrapper = document.createElement('div');
    wrapper.className = 'message-content-wrapper';

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${role === 'user' ? 'user-bubble' : 'bot-bubble'}`;

    if (role === 'user') {
      bubble.textContent = content;
    } else {
      bubble.innerHTML = marked.parse(content);
      highlightCodeBlocks(bubble);
    }

    wrapper.appendChild(bubble);
    if (role === 'user') {
      row.appendChild(wrapper);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(wrapper);
    }

    messagesContainer.appendChild(row);
    scrollToBottom();
  }

  function createAssistantMessageUI() {
    const row = document.createElement('div');
    row.className = 'message-row bot-row';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar bot-avatar';
    avatar.textContent = '⚡';

    const wrapper = document.createElement('div');
    wrapper.className = 'message-content-wrapper';

    const toolContainer = document.createElement('div');
    toolContainer.className = 'tool-badges-list';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble bot-bubble';
    bubble.innerHTML = '<span class="typing-cursor"></span>';

    wrapper.appendChild(toolContainer);
    wrapper.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(wrapper);

    messagesContainer.appendChild(row);
    scrollToBottom();

    return { bubbleEl: bubble, toolContainerEl: toolContainer, rowEl: row };
  }

  function renderAssistantMarkdown(bubbleEl, text, isTyping) {
    if (!text && isTyping) {
      bubbleEl.innerHTML = '<span class="typing-cursor"></span>';
      return;
    }
    const html = marked.parse(text);
    bubbleEl.innerHTML = html + (isTyping ? '<span class="typing-cursor"></span>' : '');
  }

  function renderToolBadge(container, toolName, status, args, result) {
    let badge = container.querySelector(`[data-tool="${toolName}"]`);
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'tool-badge';
      badge.setAttribute('data-tool', toolName);
      container.appendChild(badge);
    }

    if (status === 'running') {
      badge.innerHTML = `<span class="tool-spinner"></span> <span>Running <strong>${toolName}</strong>...</span>`;
    } else {
      badge.innerHTML = `<span>✓</span> <span>Used <strong>${toolName}</strong></span>`;
    }
  }

  function highlightCodeBlocks(el) {
    el.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
      // Add copy button if not exists
      const pre = block.parentElement;
      if (!pre.querySelector('.code-header')) {
        const lang = block.className.replace('language-', '') || 'code';
        const header = document.createElement('div');
        header.className = 'code-header';
        header.innerHTML = `
          <span>${lang}</span>
          <button class="copy-code-btn">Copy</button>
        `;
        const copyBtn = header.querySelector('.copy-code-btn');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(block.innerText).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => (copyBtn.textContent = 'Copy'), 2000);
          });
        });
        pre.insertBefore(header, block);
      }
    });
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // -------------------------------------------------------------
  // Session Management (Synced with Database)
  // -------------------------------------------------------------
  function createNewSessionId() {
    const id = 'sess_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('active_session_id', id);
    return id;
  }

  async function fetchSessions() {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        sessions = await res.json();
        localStorage.setItem('chat_sessions', JSON.stringify(sessions));
      }
    } catch (e) {
      console.warn('Could not fetch sessions from DB:', e);
    }
    renderSessions();
  }

  async function startNewChat() {
    currentSessionId = createNewSessionId();
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentSessionId, title: 'New Chat' }),
      });
    } catch (e) {
      console.warn(e);
    }
    messagesContainer.innerHTML = '';
    messagesContainer.appendChild(welcomeHero);
    welcomeHero.style.display = 'flex';
    await fetchSessions();
  }

  async function ensureSessionExists(firstMessage) {
    let session = sessions.find((s) => s.id === currentSessionId);
    if (!session) {
      const title = firstMessage.slice(0, 30) + (firstMessage.length > 30 ? '...' : '');
      try {
        await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: currentSessionId, title: title }),
        });
      } catch (e) {
        console.warn(e);
      }
      await fetchSessions();
    }
  }

  function renderSessions() {
    sessionsList.innerHTML = '';
    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = `session-item ${s.id === currentSessionId ? 'active' : ''}`;
      item.innerHTML = `
        <span class="session-title">${escapeHtml(s.title || 'New Chat')}</span>
        <button class="session-del-btn" title="Delete conversation">&times;</button>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('session-del-btn')) {
          e.stopPropagation();
          deleteSession(s.id);
          return;
        }
        switchSession(s.id);
      });

      sessionsList.appendChild(item);
    });
  }

  async function switchSession(id) {
    if (id === currentSessionId) return;
    currentSessionId = id;
    localStorage.setItem('active_session_id', id);
    renderSessions();
    await loadSessionHistory(id);
    if (sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
    }
  }

  async function deleteSession(id) {
    sessions = sessions.filter((s) => s.id !== id);
    localStorage.setItem('chat_sessions', JSON.stringify(sessions));
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });

    if (id === currentSessionId) {
      startNewChat();
    } else {
      renderSessions();
    }
  }

  async function loadSessionHistory(sessionId) {
    try {
      const res = await fetch(`/api/history/${sessionId}`);
      const data = await res.json();
      messagesContainer.innerHTML = '';

      if (!data.messages || data.messages.length === 0) {
        messagesContainer.appendChild(welcomeHero);
        welcomeHero.style.display = 'flex';
      } else {
        welcomeHero.style.display = 'none';
        data.messages.forEach((msg) => {
          appendMessageUI(msg.role, msg.content);
        });
      }
    } catch (err) {
      console.warn('Could not load history:', err);
    }
  }

  function exportConversation() {
    fetch(`/api/history/${currentSessionId}`)
      .then((res) => res.json())
      .then((data) => {
        let text = `# Chat Export - Session ${currentSessionId}\n\n`;
        (data.messages || []).forEach((m) => {
          text += `### ${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}\n\n---\n\n`;
        });
        const blob = new Blob([text], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_${currentSessionId}.md`;
        a.click();
      });
  }

  // -------------------------------------------------------------
  // Settings & Theme
  // -------------------------------------------------------------
  function openSettings() {
    providerSelect.value = config.provider;
    modelInput.value = config.model;
    tempSlider.value = config.temperature;
    tempVal.textContent = config.temperature;
    systemPromptInput.value = config.systemPrompt;
    providerDesc.textContent = providerDefaults[config.provider]?.desc || '';
    settingsModal.classList.add('open');
  }

  function closeSettings() {
    settingsModal.classList.remove('open');
  }

  function updateHeaderPill() {
    headerProviderName.textContent = providerSelect.options[providerSelect.selectedIndex]?.text.split(' ')[0] || config.provider.toUpperCase();
    headerModelName.textContent = config.model;
  }

  function initTheme() {
    const savedTheme = localStorage.getItem('app_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeUI(savedTheme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('app_theme', next);
    updateThemeUI(next);
  }

  // -------------------------------------------------------------
  // Long-Term Memory (Mem0) Modal Management
  // -------------------------------------------------------------
  const memoriesModal = document.getElementById('memories-modal');
  const openMemoriesBtn = document.getElementById('open-memories-btn');
  const closeMemoriesBtn = document.getElementById('close-memories-btn');
  const closeMemoriesDoneBtn = document.getElementById('close-memories-done-btn');
  const clearAllMemoriesBtn = document.getElementById('clear-all-memories-btn');
  const memoriesList = document.getElementById('memories-list');

  openMemoriesBtn.addEventListener('click', openMemories);
  closeMemoriesBtn.addEventListener('click', closeMemories);
  closeMemoriesDoneBtn.addEventListener('click', closeMemories);
  memoriesModal.addEventListener('click', (e) => {
    if (e.target === memoriesModal) closeMemories();
  });

  clearAllMemoriesBtn.addEventListener('click', async () => {
    if (confirm('Clear all long-term memories learned about you?')) {
      await fetch('/api/memories/default_user', { method: 'DELETE' });
      await loadMemories();
    }
  });

  async function openMemories() {
    memoriesModal.classList.add('open');
    await loadMemories();
  }

  function closeMemories() {
    memoriesModal.classList.remove('open');
  }

  async function loadMemories() {
    memoriesList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">Loading memories...</div>';
    try {
      const res = await fetch('/api/memories/default_user');
      const data = await res.json();
      memoriesList.innerHTML = '';
      if (!data.memories || data.memories.length === 0) {
        memoriesList.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 12px; text-align: center; border: 1px dashed var(--border-color); border-radius: var(--radius-sm);">No facts stored yet. Start chatting and the AI will remember details about you!</div>';
        return;
      }

      data.memories.forEach((m) => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 0.88rem;';
        item.innerHTML = `
          <span>${escapeHtml(m.memory || m)}</span>
          <button class="mem-del-btn" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 6px; font-size: 1rem;" title="Delete this memory">&times;</button>
        `;
        const delBtn = item.querySelector('.mem-del-btn');
        delBtn.addEventListener('click', async () => {
          if (m.id) {
            await fetch(`/api/memories/default_user/${m.id}`, { method: 'DELETE' });
          }
          await loadMemories();
        });
        memoriesList.appendChild(item);
      });
    } catch (e) {
      memoriesList.innerHTML = '<div style="color: #ef4444;">Failed to load memories.</div>';
    }
  }

  function updateThemeUI(theme) {
    if (theme === 'dark') {
      themeIcon.textContent = '🌙';
      themeText.textContent = 'Dark Mode';
    } else {
      themeIcon.textContent = '☀️';
      themeText.textContent = 'Light Mode';
    }
  }

  function setupAutoResize() {
    userInput.addEventListener('input', () => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 180) + 'px';
    });
  }

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
