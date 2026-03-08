(function () {
  const vscode = acquireVsCodeApi();
  const events = document.getElementById('events');
  const pidEl = document.getElementById('pid');
  const promptEl = document.getElementById('prompt');
  const suggestionEl = document.getElementById('suggestion');
  const statusEl = document.getElementById('status');
  const askBtn = document.getElementById('ask');
  const cancelBtn = document.getElementById('cancel');
  const acceptBtn = document.getElementById('accept');
  const copyBtn = document.getElementById('copy');
  const clearBtn = document.getElementById('clear');

  let currentRequestId = null;
  let currentText = '';
  let streaming = false;

  function log(s) {
    events.textContent += s + '\n';
    events.scrollTop = events.scrollHeight;
  }

  function setStatus(s) {
    statusEl.textContent = s || '';
  }

  try {
    vscode.postMessage({ type: 'ready' });
  } catch (e) {
    /* ignore */
  }

  
  document.getElementById('start-terminal').addEventListener('click', () => {
    vscode.postMessage({ type: 'startTerminal' });
  });
  

  askBtn.addEventListener('click', () => {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      setStatus('Enter a prompt');
      return;
    }
    currentRequestId = 'req-' + Date.now();
    currentText = '';
    suggestionEl.textContent = '';
    acceptBtn.disabled = true;
    copyBtn.disabled = true;
    streaming = true;
    setStatus('Requesting...');
    vscode.postMessage({ type: 'request_completion', id: currentRequestId, prompt });
    log('[UI] sent completion request ' + currentRequestId);
  });

  cancelBtn.addEventListener('click', () => {
    if (streaming && currentRequestId) {
      try {
        vscode.postMessage({
          type: 'sendCommand',
          command: { type: 'stop', id: currentRequestId },
        });
      } catch (e) {}
      streaming = false;
      setStatus('Cancelled');
    }
  });

  acceptBtn.addEventListener('click', () => {
    if (!currentText) return;
    vscode.postMessage({ type: 'applyEdit', text: currentText });
    setStatus('Inserted');
  });

  copyBtn.addEventListener('click', async () => {
    if (!currentText) return;
    try {
      await navigator.clipboard.writeText(currentText);
      setStatus('Copied to clipboard');
    } catch (e) {
      setStatus('Copy failed');
    }
  });

  clearBtn.addEventListener('click', () => {
    promptEl.value = '';
    suggestionEl.textContent = '';
    currentText = '';
    currentRequestId = null;
    acceptBtn.disabled = true;
    copyBtn.disabled = true;
    setStatus('');
  });

  function handleAssistantEvent(ev) {
    log(JSON.stringify(ev));
  }
  window.addEventListener('message', event => {
    const msg = event.data;

    // direct messages like rpcStarted/terminalStarted/error
    if (msg.type === 'rpcStarted') {
      pidEl.textContent = msg.pid ? 'RPC pid: ' + msg.pid : 'RPC started (pid unknown)';
      //log('[INFO] rpc started' + (msg.pid ? ' (pid: ' + msg.pid + ')' : ''));
      setStatus('RPC running');
      return;
    }else{
      handleAssistantEvent(msg);
    }
  });
})();
