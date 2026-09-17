/**
 * ============================================================================
 * Collaborative Rich Text Editor Controller & View Layer
 * ============================================================================
 * Seamlessly couples the CRDT engine, Live Awareness cursors/selection,
 * Offline-first IndexedDB persistence, and the Mentor Chaos Testing Panel.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Parse room from URL query (e.g. ?room=hackathon-demo) or generate default
  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room') || 'default-doc';
  const customName = urlParams.get('name');

  // DOM Elements
  const editorEl = document.getElementById('editor');
  const titleEl = document.getElementById('doc-title');
  const roomNameDisplay = document.getElementById('room-name-display');
  const statusBadge = document.getElementById('connection-status');
  const peerAvatarsContainer = document.getElementById('peer-avatars');
  const peerCountBadge = document.getElementById('peer-count-badge');
  const remoteCursorsContainer = document.getElementById('remote-cursors-layer');
  const wordCountEl = document.getElementById('word-count');
  const charCountEl = document.getElementById('char-count');
  const readingTimeEl = document.getElementById('reading-time');
  const userProfileBtn = document.getElementById('user-profile-btn');

  // Initialize Core CRDT Document
  const doc = new window.CRDTDoc();
  const awareness = new window.Awareness(doc);
  if (customName) awareness.setLocalUserName(customName);

  // Initialize Offline Persistence
  const persistence = new window.LocalPersistence(room, doc);

  // Update room label
  if (roomNameDisplay) roomNameDisplay.textContent = room;

  // Initialize Network & Chaos Adapter
  let ws = null;
  let isConnecting = false;

  const chaosAdapter = new window.ChaosNetworkAdapter((message) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
  });

  // Mentor Diagnostics Suite
  const mentorSuite = new window.MentorSuite({
    doc,
    awareness,
    chaosAdapter,
    onUpdateUI: updateMentorHUD
  });

  // Track if we are currently applying a remote update to prevent input feedback loops
  let isApplyingRemoteUpdate = false;

  // Setup WebSocket Connection
  function connectWebSocket() {
    if (isConnecting) return;
    isConnecting = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(room)}&client=${encodeURIComponent(doc.clientId)}`;

    updateStatusBadge('connecting');

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        isConnecting = false;
        console.log('[WebSocket] Connected to room:', room);
        updateStatusBadge('connected');

        // Step 1: Send local State Vector to server to request missing deltas
        const sv = doc.getStateVector();
        chaosAdapter.send({
          type: 'sync-step-1',
          room,
          stateVector: sv,
          clientId: doc.clientId
        });

        // Broadcast local awareness state
        chaosAdapter.send({
          type: 'awareness',
          room,
          payload: awareness.encodeLocalState()
        });

        // Start ping heartbeat
        startPingHeartbeat();
      };

      ws.onmessage = (event) => {
        chaosAdapter.receive(event.data, (raw) => {
          try {
            const msg = JSON.parse(raw);
            handleIncomingMessage(msg);
          } catch (e) {
            console.error('[WebSocket] Failed to parse message:', e);
          }
        });
      };

      ws.onclose = () => {
        isConnecting = false;
        console.warn('[WebSocket] Disconnected from server');
        updateStatusBadge(chaosAdapter.isOnline ? 'disconnected' : 'partitioned');
        
        // Auto-reconnect if still supposedly online
        if (chaosAdapter.isOnline) {
          setTimeout(connectWebSocket, 2000);
        }
      };

      ws.onerror = (err) => {
        console.error('[WebSocket] Error:', err);
        ws.close();
      };
    } catch (err) {
      isConnecting = false;
      console.error('[WebSocket] Connection attempt failed:', err);
      setTimeout(connectWebSocket, 3000);
    }
  }

  function handleIncomingMessage(msg) {
    if (msg.type === 'sync-step-1') {
      // Peer/server wants our missing operations since their stateVector
      const deltas = doc.getDeltaSince(msg.stateVector);
      if (deltas.length > 0) {
        chaosAdapter.send({
          type: 'sync-step-2',
          room,
          operations: deltas
        });
      }
    } else if (msg.type === 'sync-step-2') {
      // Received missing operations
      isApplyingRemoteUpdate = true;
      doc.applyUpdate({ operations: msg.operations });
      isApplyingRemoteUpdate = false;
      renderDocument();
      persistence.scheduleSave();

      // Also reciprocate state vector if server had fewer updates
      const localSV = doc.getStateVector();
      const serverSV = msg.serverStateVector;
      if (serverSV) {
        const myDeltas = doc.getDeltaSince(serverSV);
        if (myDeltas.length > 0) {
          chaosAdapter.send({
            type: 'update',
            room,
            operations: myDeltas
          });
        }
      }
    } else if (msg.type === 'update') {
      // Real-time incremental delta
      isApplyingRemoteUpdate = true;
      doc.applyUpdate({ operations: msg.operations });
      isApplyingRemoteUpdate = false;
      renderDocument();
      persistence.scheduleSave();
    } else if (msg.type === 'awareness') {
      awareness.applyRemoteState(msg.payload);
      renderCollaborators();
      renderRemoteCursors();
    } else if (msg.type === 'pong') {
      const rtt = Date.now() - msg.timestamp;
      chaosAdapter.pingMs = rtt;
    }
  }

  let pingInterval = null;
  function startPingHeartbeat() {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && chaosAdapter.isOnline) {
        chaosAdapter.send({
          type: 'ping',
          timestamp: Date.now()
        });

        // Periodic awareness heartbeat
        chaosAdapter.send({
          type: 'awareness',
          room,
          payload: awareness.encodeLocalState()
        });
      }
    }, 5000);
  }

  // Handle local CRDT updates -> broadcast to peers & schedule persistence
  doc.on('update', ({ operations, origin }) => {
    if (origin === 'local') {
      chaosAdapter.send({
        type: 'update',
        room,
        operations
      });
      persistence.scheduleSave();
    }
  });

  doc.on('change', () => {
    updateWordAndCharCount();
  });

  awareness.on('change', () => {
    renderCollaborators();
    renderRemoteCursors();
  });

  // UI Status Indicator
  function updateStatusBadge(status) {
    if (!statusBadge) return;
    statusBadge.className = 'status-badge ' + status;
    if (status === 'connected') {
      statusBadge.innerHTML = '<span class="status-dot green"></span> Live';
    } else if (status === 'connecting') {
      statusBadge.innerHTML = '<span class="status-dot yellow"></span> Connecting...';
    } else if (status === 'partitioned') {
      statusBadge.innerHTML = '<span class="status-dot red"></span> Partitioned (Offline)';
    } else {
      statusBadge.innerHTML = '<span class="status-dot gray"></span> Disconnected';
    }
  }

  // Render Collaborator Avatars in Top Bar
  function renderCollaborators() {
    if (!peerAvatarsContainer) return;
    peerAvatarsContainer.innerHTML = '';

    const states = Array.from(awareness.states.values());
    if (peerCountBadge) {
      peerCountBadge.textContent = `${states.length} active`;
    }

    states.forEach(state => {
      const user = state.user;
      if (!user) return;
      const avatar = document.createElement('div');
      avatar.className = 'avatar-bubble';
      avatar.style.backgroundColor = user.color;
      avatar.title = `${user.name} ${state.clientID === doc.clientId ? '(You)' : ''}`;
      avatar.textContent = user.initials;
      peerAvatarsContainer.appendChild(avatar);
    });
  }

  // Render Document Text & Formatting Spans
  function renderDocument() {
    const text = doc.getText();
    
    // If empty, show placeholder
    if (text.length === 0) {
      editorEl.innerHTML = '<p><br></p>';
      updateWordAndCharCount();
      return;
    }

    // Save selection anchor
    const sel = window.getSelection();
    let savedOffset = 0;
    if (sel.rangeCount > 0 && editorEl.contains(sel.anchorNode)) {
      savedOffset = getCaretCharacterOffsetWithin(editorEl);
    }

    // Render formatted chunks
    const chunks = doc.getFormattedChunks();
    const fragment = document.createDocumentFragment();

    let currentPara = document.createElement('p');
    fragment.appendChild(currentPara);

    chunks.forEach(chunk => {
      const lines = chunk.text.split('\n');
      
      lines.forEach((line, idx) => {
        if (idx > 0) {
          // New paragraph on newline
          currentPara = document.createElement('p');
          fragment.appendChild(currentPara);
        }

        if (line.length > 0) {
          let span = document.createElement('span');
          span.textContent = line;

          const a = chunk.attributes;
          if (a.bold) span.style.fontWeight = '700';
          if (a.italic) span.style.fontStyle = 'italic';
          if (a.underline) span.style.textDecoration = 'underline';
          if (a.strike) span.style.textDecoration = (span.style.textDecoration ? span.style.textDecoration + ' ' : '') + 'line-through';
          if (a.code) {
            span.className = 'inline-code';
          }
          if (a.heading === 1) {
            const h = document.createElement('h1');
            h.appendChild(span);
            fragment.replaceChild(h, currentPara);
            currentPara = h;
          } else if (a.heading === 2) {
            const h = document.createElement('h2');
            h.appendChild(span);
            fragment.replaceChild(h, currentPara);
            currentPara = h;
          }

          currentPara.appendChild(span);
        }
      });
    });

    // Make sure empty paragraphs have a break
    fragment.querySelectorAll('p, h1, h2').forEach(node => {
      if (node.childNodes.length === 0) {
        node.appendChild(document.createElement('br'));
      }
    });

    editorEl.innerHTML = '';
    editorEl.appendChild(fragment);

    // Restore caret position
    if (savedOffset > 0) {
      setCaretPosition(editorEl, savedOffset);
    }

    updateWordAndCharCount();
  }

  // Render Remote Floating Cursors & Labels
  function renderRemoteCursors() {
    if (!remoteCursorsContainer) return;
    remoteCursorsContainer.innerHTML = '';

    const remotes = awareness.getRemoteStates();
    remotes.forEach(remote => {
      if (!remote.cursor) return;

      const cursorIndex = remote.cursor.index;
      const coords = getCoordinatesForCharIndex(cursorIndex);
      if (!coords) return;

      const cursorDiv = document.createElement('div');
      cursorDiv.className = 'remote-cursor';
      cursorDiv.style.left = `${coords.left}px`;
      cursorDiv.style.top = `${coords.top}px`;
      cursorDiv.style.height = `${coords.height || 22}px`;
      cursorDiv.style.backgroundColor = remote.user.color;

      const tag = document.createElement('div');
      tag.className = 'remote-cursor-tag';
      tag.style.backgroundColor = remote.user.color;
      tag.textContent = remote.user.name;

      cursorDiv.appendChild(tag);
      remoteCursorsContainer.appendChild(cursorDiv);
    });
  }

  // Helper to get bounding box coordinates for a character index in editorEl
  function getCoordinatesForCharIndex(index) {
    const editorRect = editorEl.getBoundingClientRect();
    const treeWalker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let textNode = null;
    let offsetInNode = 0;

    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode;
      const len = node.nodeValue.length;
      if (charCount + len >= index) {
        textNode = node;
        offsetInNode = Math.max(0, index - charCount);
        break;
      }
      charCount += len;
    }

    if (!textNode) {
      return {
        left: 24,
        top: 24,
        height: 22
      };
    }

    const range = document.createRange();
    const safeOffset = Math.min(offsetInNode, textNode.nodeValue.length);
    range.setStart(textNode, safeOffset);
    range.setEnd(textNode, safeOffset);

    const rect = range.getBoundingClientRect();
    return {
      left: rect.left - editorRect.left + editorEl.scrollLeft,
      top: rect.top - editorRect.top + editorEl.scrollTop,
      height: rect.height || 22
    };
  }

  // Caret Offset Calculation
  function getCaretCharacterOffsetWithin(element) {
    let caretOffset = 0;
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(range.endContainer, range.endOffset);
      caretOffset = preCaretRange.toString().length;
    }
    return caretOffset;
  }

  function setCaretPosition(element, offset) {
    const treeWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let targetNode = null;
    let targetOffset = 0;

    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode;
      const len = node.nodeValue.length;
      if (currentOffset + len >= offset) {
        targetNode = node;
        targetOffset = offset - currentOffset;
        break;
      }
      currentOffset += len;
    }

    if (targetNode) {
      const range = document.createRange();
      const sel = window.getSelection();
      range.setStart(targetNode, Math.min(targetOffset, targetNode.nodeValue.length));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // Handle Input Events from Editor
  let previousText = '';
  editorEl.addEventListener('beforeinput', (e) => {
    previousText = editorEl.innerText || '';
  });

  editorEl.addEventListener('input', (e) => {
    if (isApplyingRemoteUpdate) return;

    const currentText = (editorEl.innerText || '').replace(/\r\n/g, '\n');
    const caretPos = getCaretCharacterOffsetWithin(editorEl);

    // Compute diff between previousText and currentText
    const oldStr = previousText;
    const newStr = currentText;

    let start = 0;
    while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
      start++;
    }

    let endOld = oldStr.length;
    let endNew = newStr.length;
    while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
      endOld--;
      endNew--;
    }

    const deleteCount = endOld - start;
    const insertedChars = newStr.substring(start, endNew);

    // Apply deletes first
    for (let i = 0; i < deleteCount; i++) {
      doc.delete(start);
    }

    // Apply inserts
    if (insertedChars.length > 0) {
      doc.insert(start, insertedChars, currentActiveAttributes);
    }

    previousText = currentText;

    // Broadcast cursor position
    awareness.setLocalCursor(caretPos);
    chaosAdapter.send({
      type: 'awareness',
      room,
      payload: awareness.encodeLocalState()
    });

    renderRemoteCursors();
  });

  // Track selection changes and cursor movements
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== editorEl) return;
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return;

    const offset = getCaretCharacterOffsetWithin(editorEl);
    awareness.setLocalCursor(offset);

    chaosAdapter.send({
      type: 'awareness',
      room,
      payload: awareness.encodeLocalState()
    });
  });

  // Formatting State & Toolbar Handling
  let currentActiveAttributes = {};

  function setupToolbar() {
    const buttons = {
      'btn-bold': () => toggleFormat('bold'),
      'btn-italic': () => toggleFormat('italic'),
      'btn-underline': () => toggleFormat('underline'),
      'btn-strike': () => toggleFormat('strike'),
      'btn-code': () => toggleFormat('code'),
      'btn-h1': () => toggleHeading(1),
      'btn-h2': () => toggleHeading(2),
      'btn-clear': () => clearFormatting(),
      'btn-undo': () => { doc.undoManager.undo(); renderDocument(); },
      'btn-redo': () => { doc.undoManager.redo(); renderDocument(); }
    };

    for (const [id, action] of Object.entries(buttons)) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          action();
        });
      }
    }
  }

  function toggleFormat(attr) {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      // Toggle for next typed character
      currentActiveAttributes[attr] = !currentActiveAttributes[attr];
      updateToolbarUI();
      return;
    }

    const startOffset = Math.min(
      getCaretCharacterOffsetWithin(editorEl),
      getCaretCharacterOffsetWithin(editorEl)
    );
    const selectedText = sel.toString();
    const length = selectedText.length;

    const currentVal = !currentActiveAttributes[attr];
    currentActiveAttributes[attr] = currentVal;

    doc.format(startOffset, length, { [attr]: currentVal });
    renderDocument();
    updateToolbarUI();
  }

  function toggleHeading(level) {
    const sel = window.getSelection();
    const offset = getCaretCharacterOffsetWithin(editorEl);
    const currentHeading = currentActiveAttributes.heading === level ? null : level;
    currentActiveAttributes.heading = currentHeading;
    
    // Apply to current paragraph
    const text = doc.getText();
    let pStart = text.lastIndexOf('\n', offset - 1) + 1;
    let pEnd = text.indexOf('\n', offset);
    if (pEnd === -1) pEnd = text.length;

    doc.format(pStart, Math.max(1, pEnd - pStart), { heading: currentHeading });
    renderDocument();
  }

  function clearFormatting() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      currentActiveAttributes = {};
      return;
    }
    const offset = getCaretCharacterOffsetWithin(editorEl);
    const len = sel.toString().length;
    doc.format(offset, len, {
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      code: false,
      heading: null
    });
    currentActiveAttributes = {};
    renderDocument();
  }

  function updateToolbarUI() {
    // Toggle active classes on toolbar buttons
    ['bold', 'italic', 'underline', 'strike', 'code'].forEach(attr => {
      const btn = document.getElementById(`btn-${attr}`);
      if (btn) {
        btn.classList.toggle('active', !!currentActiveAttributes[attr]);
      }
    });
  }

  // Document Metrics
  function updateWordAndCharCount() {
    const text = doc.getText();
    const chars = text.length;
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const readMins = Math.ceil(words / 200);

    if (charCountEl) charCountEl.textContent = `${chars} chars`;
    if (wordCountEl) wordCountEl.textContent = `${words} words`;
    if (readingTimeEl) readingTimeEl.textContent = `${readMins} min read`;
  }

  // Update Mentor Diagnostic HUD
  function updateMentorHUD(metrics) {
    const hudVector = document.getElementById('hud-vector-clock');
    const hudItems = document.getElementById('hud-items');
    const hudTombstones = document.getElementById('hud-tombstones');
    const hudMemory = document.getElementById('hud-memory');
    const hudLatency = document.getElementById('hud-latency');
    const hudPending = document.getElementById('hud-pending');

    if (hudVector) hudVector.textContent = JSON.stringify(metrics.stateVector);
    if (hudItems) hudItems.textContent = `${metrics.visibleCharacters} vis / ${metrics.totalItems} total`;
    if (hudTombstones) hudTombstones.textContent = `${metrics.tombstoneCount} (${(metrics.tombstoneRatio * 100).toFixed(1)}%)`;
    if (hudMemory) hudMemory.textContent = `${(metrics.estimatedMemoryBytes / 1024).toFixed(2)} KB`;
    if (hudLatency) hudLatency.textContent = `${metrics.pingMs} ms (RTT)`;
    if (hudPending) hudPending.textContent = `${metrics.pendingOfflineOps} ops`;
  }

  // Setup Mentor & Chaos Simulator Controls
  function setupChaosControls() {
    const toggleOnlineBtn = document.getElementById('chaos-toggle-online');
    const latencySelect = document.getElementById('chaos-latency-select');
    const dropSlider = document.getElementById('chaos-drop-slider');
    const dropVal = document.getElementById('chaos-drop-value');
    const benchmarkBtn = document.getElementById('btn-run-benchmark');
    const benchmarkResultEl = document.getElementById('benchmark-result');
    const splitViewBtn = document.getElementById('btn-split-sandbox');

    if (toggleOnlineBtn) {
      toggleOnlineBtn.addEventListener('click', () => {
        const nextState = !chaosAdapter.isOnline;
        chaosAdapter.setOnline(nextState, (flushedCount) => {
          console.log(`[Chaos] Flushed ${flushedCount} operations.`);
        });

        toggleOnlineBtn.textContent = nextState ? 'Simulate Partition (Go Offline)' : 'Heal Partition (Go Online)';
        toggleOnlineBtn.className = nextState ? 'btn-chaos-offline' : 'btn-chaos-online';
        updateStatusBadge(nextState ? 'connected' : 'partitioned');
      });
    }

    if (latencySelect) {
      latencySelect.addEventListener('change', (e) => {
        const ms = parseInt(e.target.value, 10);
        chaosAdapter.setLatency(ms);
      });
    }

    if (dropSlider) {
      dropSlider.addEventListener('input', (e) => {
        const rate = parseFloat(e.target.value);
        chaosAdapter.setPacketLoss(rate);
        if (dropVal) dropVal.textContent = `${Math.round(rate * 100)}%`;
      });
    }

    if (benchmarkBtn) {
      benchmarkBtn.addEventListener('click', async () => {
        benchmarkBtn.disabled = true;
        benchmarkBtn.textContent = 'Running 100 Concurrent Ops...';
        if (benchmarkResultEl) benchmarkResultEl.innerHTML = '<span class="spinner"></span> Fuzzing convergence...';

        const result = await mentorSuite.runLiveConvergenceBenchmark(100);
        benchmarkBtn.disabled = false;
        benchmarkBtn.textContent = 'Run Convergence Fuzz Test';

        if (benchmarkResultEl) {
          benchmarkResultEl.innerHTML = `
            <div class="benchmark-badge ${result.success ? 'success' : 'failed'}">
              <strong>${result.success ? '100% Deterministic Convergence PASSED' : 'FAILED'}</strong><br>
              Resolved: ${result.conflictsResolved} conflicts in ${result.elapsedMs}ms (${result.opsPerSec} ops/sec)
            </div>
          `;
        }
      });
    }

    if (splitViewBtn) {
      splitViewBtn.addEventListener('click', () => {
        toggleSplitViewSandbox();
      });
    }
  }

  // Side-by-Side Dual Client Split Sandbox (Live Hackathon Demo Mode)
  function toggleSplitViewSandbox() {
    const sandboxContainer = document.getElementById('split-sandbox-container');
    const mainWorkspace = document.getElementById('main-workspace');

    if (!sandboxContainer) return;

    if (sandboxContainer.classList.contains('active')) {
      sandboxContainer.classList.remove('active');
      sandboxContainer.innerHTML = '';
      if (mainWorkspace) mainWorkspace.classList.remove('half-width');
    } else {
      sandboxContainer.classList.add('active');
      if (mainWorkspace) mainWorkspace.classList.add('half-width');

      const secondClientUrl = `${window.location.origin}/?room=${encodeURIComponent(room)}&name=Bob%20(Peer%202)&embed=true`;
      sandboxContainer.innerHTML = `
        <div class="split-sandbox-header">
          <span>Peer Client B ("Bob" - Live Sync)</span>
          <button id="close-sandbox" class="btn-icon">&times;</button>
        </div>
        <iframe src="${secondClientUrl}" class="split-sandbox-frame"></iframe>
      `;

      document.getElementById('close-sandbox').addEventListener('click', () => {
        toggleSplitViewSandbox();
      });
    }
  }

  // Export Tools
  function setupExportTools() {
    const exportMd = document.getElementById('export-markdown');
    const exportHtml = document.getElementById('export-html');
    const exportTxt = document.getElementById('export-txt');
    const printDoc = document.getElementById('export-print');
    const copyShareLink = document.getElementById('btn-share');

    if (exportMd) {
      exportMd.addEventListener('click', () => {
        downloadFile(`${room}.md`, doc.getText());
      });
    }
    if (exportTxt) {
      exportTxt.addEventListener('click', () => {
        downloadFile(`${room}.txt`, doc.getText());
      });
    }
    if (exportHtml) {
      exportHtml.addEventListener('click', () => {
        downloadFile(`${room}.html`, `<html><body>${editorEl.innerHTML}</body></html>`);
      });
    }
    if (printDoc) {
      printDoc.addEventListener('click', () => {
        window.print();
      });
    }
    if (copyShareLink) {
      copyShareLink.addEventListener('click', () => {
        navigator.clipboard.writeText(window.location.href);
        const orig = copyShareLink.innerHTML;
        copyShareLink.innerHTML = 'Copied!';
        setTimeout(() => copyShareLink.innerHTML = orig, 2000);
      });
    }
  }

  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Initialize all subsystems
  setupToolbar();
  setupChaosControls();
  setupExportTools();
  connectWebSocket();

  // If new empty doc, seed initial welcome text
  setTimeout(() => {
    if (doc.getText().length === 0) {
      const welcomeText = `# Welcome to SyncDoc Collaborative Editor\n\nThis is a real-time collaborative rich text editor powered by Conflict-Free Replicated Data Types (CRDTs).\n\nFeatures:\n- CRDT Replicated Growable Array (RGA) mathematical convergence\n- Multi-user live awareness, animated cursors, and presence\n- Offline-first IndexedDB persistence with zero data loss\n- Built-in Mentor Chaos & Partition Simulator (test network splits & latency below!)\n\nTry typing here or invite a collaborator using the Share button!`;
      doc.insert(0, welcomeText);
      renderDocument();
    } else {
      renderDocument();
    }
  }, 300);
});
