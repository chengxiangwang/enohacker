(function() {
  const vscode = acquireVsCodeApi();

  const outputEl = document.getElementById('output');
  const promptEl = document.getElementById('prompt');
  const sendBtn = document.getElementById('sendBtn');
  const clearBtn = document.getElementById('clearBtn');
  const abortBtn = document.getElementById('abortBtn');

  // small helpers
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Markdown renderer: prefer marked + highlight.js when available, otherwise fallback to a very small renderer
  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined') {
      try {
        return marked.parse(text);
      } catch (e) {
        // fallthrough to simple renderer
      }
    }

    // Very small markdown-like renderer fallback: supports fenced code blocks (```lang\n...```), inline `code`, and newlines -> <br>
    const fenceRe = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let out = '';
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      const before = text.slice(lastIndex, m.index);
      if (before) out += inlineFormat(escapeHtml(before));
      const lang = m[1] || '';
      const code = m[2] || '';
      out += `<pre class="code-block"><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`;
      lastIndex = fenceRe.lastIndex;
    }
    const tail = text.slice(lastIndex);
    if (tail) out += inlineFormat(escapeHtml(tail));
    return out;

    function inlineFormat(s) {
      // inline `code`
      s = s.replace(/`([^`]+)`/g, function(_, c) { return '<code>' + c + '</code>'; });
      // convert newlines to <br>
      s = s.replace(/\n/g, '<br>');
      return s;
    }
  }

  function applySimpleHighlight(container) {
    if (!container) return;
    const codeBlocks = container.querySelectorAll('.code-block code');
    codeBlocks.forEach(cb => {
      try {
        let text = cb.textContent || '';
        const langMatch = Array.from(cb.classList).find(c => c.startsWith('language-')) || '';
        const lang = langMatch.replace('language-', '');
        if (lang === 'js' || lang === 'javascript' || lang === 'ts' || lang === 'typescript') {
          // very small JS/TS keyword highlighter
          text = text.replace(/\b(const|let|var|function|if|else|return|class|new|await|async|try|catch|throw|import|from|export)\b/g, '<span class="kw">$1</span>');
          text = text.replace(/(\/\/.*$)/gm, '<span class="cm">$1</span>');
        } else if (lang === 'py' || lang === 'python') {
          text = text.replace(/\b(def|class|return|if|elif|else|import|from|as|try|except|raise|with|yield|async|await)\b/g, '<span class="kw">$1</span>');
          text = text.replace(/(#.*$)/gm, '<span class="cm">$1</span>');
        }
        cb.innerHTML = text;
      } catch (e) {
        // ignore
      }
    });
  }

  function createMessageEl(role, rawText) {
    const row = document.createElement('div');
    row.className = 'message-row ' + (role === 'user' ? 'user-row' : 'assistant-row');

    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    const avatarSrc = document.getElementById('avatarSrc');
    if (avatarSrc && avatarSrc.src) avatar.src = avatarSrc.src;

    const bubble = document.createElement('div');
    bubble.className = 'message ' + role;

    const content = document.createElement('div');
    content.className = 'message-content';
    content.dataset.rawText = rawText || '';
    content.innerHTML = renderMarkdown(content.dataset.rawText);

    bubble.appendChild(content);

    if (role === 'assistant') {
      row.appendChild(avatar);
      row.appendChild(bubble);
    } else {
      row.appendChild(bubble);
      row.appendChild(avatar);
    }

    // actions toolbar
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn';
    copyBtn.title = 'Copy';
    copyBtn.dataset.action = 'copy';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 9h8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const openBtn = document.createElement('button');
    openBtn.className = 'action-btn';
    openBtn.title = 'Open in editor';
    openBtn.dataset.action = 'open';
    openBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 12l7-7 7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'action-btn';
    saveBtn.title = 'Save to file';
    saveBtn.dataset.action = 'save';
    saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 10l5-5 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    actions.appendChild(copyBtn);
    actions.appendChild(openBtn);
    actions.appendChild(saveBtn);

    bubble.appendChild(actions);

    // Post-process: syntax highlight code blocks if hljs available, otherwise fallback
    try {
      if (typeof hljs !== 'undefined' && hljs && typeof hljs.highlightElement === 'function') {
        // highlight pre>code elements inside this content
        const codes = content.querySelectorAll('pre code');
        codes.forEach(c => {
          try { hljs.highlightElement(c); } catch (e) { /* ignore */ }
        });
      } else {
        applySimpleHighlight(content);
      }
    } catch (e) {
      // ignore
    }

    outputEl.appendChild(row);
    outputEl.scrollTop = outputEl.scrollHeight;
    return content;
  }

  function appendLine(text, cls) {
    if (cls === 'meta' || cls === 'info' || cls === 'error') {
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = text;
      outputEl.appendChild(div);
      outputEl.scrollTop = outputEl.scrollHeight;
      return;
    }

    if (cls === 'cli') {
      const div = document.createElement('div');
      div.className = 'cli';
      div.textContent = text;
      outputEl.appendChild(div);
      outputEl.scrollTop = outputEl.scrollHeight;
      return;
    }

    // Default plain message (not streaming)
    if (cls === 'assistant' || cls === 'user') {
      createMessageEl(cls, text);
    } else {
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = text;
      outputEl.appendChild(div);
    }

    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function appendDelta(delta) {
    // Append streaming delta to last assistant message-content
    let lastContent = null;
    const rows = outputEl.querySelectorAll('.message-row.assistant-row');
    if (rows.length) {
      const lastRow = rows[rows.length - 1];
      lastContent = lastRow.querySelector('.message-content');
    }
    if (!lastContent) {
      lastContent = createMessageEl('assistant', '');
    }

    // Update raw text and re-render simply
    const prev = lastContent.dataset.rawText || '';
    const updated = prev + delta;
    lastContent.dataset.rawText = updated;
    lastContent.innerHTML = renderMarkdown(updated);

    // Apply highlight
    try {
      if (typeof hljs !== 'undefined' && hljs && typeof hljs.highlightElement === 'function') {
        const codes = lastContent.querySelectorAll('pre code');
        codes.forEach(c => { try { hljs.highlightElement(c); } catch (e) {} });
      } else {
        applySimpleHighlight(lastContent);
      }
    } catch (e) {
      // ignore
    }

    outputEl.scrollTop = outputEl.scrollHeight;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'delta':
        appendDelta(msg.delta);
        break;
      case 'clear':
        outputEl.innerHTML = '';
        break;
      case 'info':
        appendLine(msg.message, 'info');
        break;
      case 'error':
        appendLine('Error: ' + msg.message, 'error');
        break;
      case 'agent_start':
        appendLine('Agent thinking...', 'meta');
        break;
      case 'agent_end':
        appendLine('Agent done', 'meta');
        break;
      case 'start_prompt':
        // create user message then prepare assistant placeholder
        const userText = promptEl.value || '';
        if (userText) {
          createMessageEl('user', userText);
        }
        promptEl.value = '';
        createMessageEl('assistant', '');
        break;
      case 'prompt_done':
        appendLine('---', 'meta');
        break;
      case 'aborted':
        appendLine('[aborted]', 'meta');
        break;
      default:
        console.log('webview got', msg);
    }
  });

  sendBtn.addEventListener('click', () => {
    const txt = promptEl.value.trim();
    if (!txt) return;
    vscode.postMessage({ command: 'prompt', text: txt });
  });
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  clearBtn.addEventListener('click', () => { vscode.postMessage({ command: 'clear' }); });
  abortBtn.addEventListener('click', () => { vscode.postMessage({ command: 'abort' }); });

  const terminalBtn = document.getElementById('terminalModeBtn');
  if (terminalBtn) {
    terminalBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'openTerminalMode' });
      appendLine('Opening terminal mode...', 'meta');
    });
  }

  // Export conversation button
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const conv = dumpConversation();
      vscode.postMessage({ command: 'exportConversation', text: conv });
      appendLine('Exporting conversation...', 'info');
    });
  }

  // Delegate action buttons via event delegation
  outputEl.addEventListener('click', (e) => {
    const tgt = e.target || (e.srcElement || null);
    const btn = tgt && typeof tgt.closest === 'function' ? tgt.closest('.action-btn') : null;
    if (!btn) return;
    const action = btn.dataset ? btn.dataset.action : undefined;
    const msgDiv = typeof btn.closest === 'function' ? btn.closest('.message') : null;
    if (!msgDiv) return;
    const content = msgDiv.querySelector('.message-content');
    if (!content) return;
    const text = content.dataset ? (content.dataset.rawText || content.innerText || '') : (content.innerText || '');
    // detect code fence language if present
    const langMatch = (text || '').match(/^```(\w+)\n/);
    const lang = langMatch ? langMatch[1] : undefined;

    switch (action) {
      case 'copy':
        vscode.postMessage({ command: 'copyToClipboard', text });
        appendLine('Copied to clipboard', 'info');
        break;
      case 'open':
        vscode.postMessage({ command: 'openInEditor', text, language: lang });
        appendLine('Opened in editor', 'info');
        break;
      case 'save':
        vscode.postMessage({ command: 'saveMessage', text, filename: 'enohacker-message.txt' });
        appendLine('Saving message...', 'info');
        break;
    }
  });

  function dumpConversation() {
    const parts = [];
    const children = Array.from(outputEl.children);
    for (const ch of children) {
      const el = ch;
      if (el.classList && el.classList.contains('message-row')) {
        const role = el.classList.contains('assistant-row') ? 'assistant' : 'user';
        const content = el.querySelector('.message-content');
        const text = content?.dataset?.rawText || content?.innerText || '';
        parts.push((role === 'user' ? 'User:' : 'Assistant:') + '\n' + text + '\n');
      } else {
        // meta/info/error
        parts.push(el.innerText || '');
      }
    }
    return parts.join('\n----\n');
  }

  // Signal ready
  vscode.postMessage({ command: 'ready' });
})();
