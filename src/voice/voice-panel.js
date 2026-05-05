/**
 * Voice Panel — Left panel UI: mic button, waveform, transcript, text input
 */
import { bus } from '../core/event-bus.js';

export class VoicePanel {
  constructor(container, stt, tts, sessionManager, agentEngine) {
    this.el = container;
    this.stt = stt;
    this.tts = tts;
    this.sessionManager = sessionManager;
    this.agent = agentEngine;
    this.entries = [];
    this._build();
    this._listen();
    this._listenToSessions();
  }

  _build() {
    this.el.innerHTML = `
      <div class="panel-section voice-section">
        <div class="panel-section__header" style="flex-direction: column; align-items: flex-start; gap: var(--sp-3);">
          <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
            <span class="panel-section__title">Voice Interface</span>
            <span class="mic-label" id="mic-status" style="font-size: 11px; color: var(--text-tertiary);">${this.stt.supported ? 'Ready' : 'Not supported'}</span>
          </div>
          
          <div class="voice-controls-grid" style="display: flex; flex-wrap: wrap; gap: var(--sp-2); width: 100%; background: var(--bg-tertiary); padding: var(--sp-2); border-radius: 6px; border: 1px solid var(--border-subtle);">
            
            <label style="font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary);">
              <input type="checkbox" id="toggle-stt" checked>
              <span>STT (Listen)</span>
            </label>
            
            <label style="font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary);">
              <input type="checkbox" id="toggle-tts" checked>
              <span>TTS (Speak)</span>
            </label>

            <label style="font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary);" title="Bypass AI and echo your voice">
              <input type="checkbox" id="toggle-sts">
              <span>STS (Voice Changer)</span>
            </label>
            
            <!-- Future hook for Conversational AI Agent -->
            <label style="font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary);" title="Continuous Live Conversation">
              <input type="checkbox" id="toggle-agent" ${this.agent?.supported ? '' : 'disabled'}>
              <span>Live Agent</span>
            </label>



            <button class="btn btn-ghost" id="replay-tts-btn" style="padding: 2px 6px; margin-left: auto; color: var(--text-secondary); opacity: 0.5; transition: opacity 0.2s;" title="Replay last AI voice">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
            </button>

            <button class="btn btn-ghost" id="stop-tts-btn" disabled style="padding: 2px 6px; color: var(--text-secondary); opacity: 0.5; transition: opacity 0.2s;" title="Stop AI talking">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>
            </button>
          </div>
        </div>
        <div class="mic-container">
          <button class="mic-btn" id="mic-btn" title="Click to speak">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </button>
          <div class="waveform" id="waveform" style="display:none;">
            ${Array.from({ length: 20 }, () => '<div class="waveform__bar" style="height:4px;"></div>').join('')}
          </div>
        </div>
      </div>

      <div class="panel-section" style="padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border-subtle);">
        <div style="display:flex; gap: var(--sp-2);">
          <input class="form-input" id="text-input" type="text" placeholder="Type a query…" style="flex:1;" />
          <button class="btn btn-primary btn-sm" id="send-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>

      <div class="session-header" style="display:flex; gap:var(--sp-2); padding:var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border-subtle); background: var(--bg-secondary);">
        <select id="session-select" class="form-input" style="flex:1; padding: 4px; font-size: 13px;"></select>
        <button class="btn btn-secondary btn-sm" id="save-session-btn" title="Save Session to Knowledge Graph">💾</button>
        <button class="btn btn-secondary btn-sm" id="new-session-btn" title="New Session">➕</button>
        <button class="btn btn-secondary btn-sm" id="delete-session-btn" title="Delete Session" style="color: var(--text-danger);">🗑️</button>
      </div>

      <div class="transcript-area" id="transcript-area">
        <div class="inspector-empty" style="height:100%;">
          <div class="inspector-empty__icon">🧠</div>
          <div>Speak or type to begin</div>
          <div style="font-size:11px; color:var(--text-quaternary);">Your conversation will appear here</div>
        </div>
      </div>

      <div class="transcript-interim" id="interim-text" style="display:none;"></div>
    `;

    this.micBtn = this.el.querySelector('#mic-btn');
    this.micStatus = this.el.querySelector('#mic-status');
    this.replayTtsBtn = this.el.querySelector('#replay-tts-btn');
    this.stopTtsBtn = this.el.querySelector('#stop-tts-btn');
    this.toggleSttBtn = this.el.querySelector('#toggle-stt');
    this.toggleStsBtn = this.el.querySelector('#toggle-sts');
    this.toggleTtsBtn = this.el.querySelector('#toggle-tts');
    this.toggleAgentBtn = this.el.querySelector('#toggle-agent');

    this.waveform = this.el.querySelector('#waveform');
    this.waveBars = this.el.querySelectorAll('.waveform__bar');
    this.transcriptArea = this.el.querySelector('#transcript-area');
    this.interimText = this.el.querySelector('#interim-text');
    this.textInput = this.el.querySelector('#text-input');
    this.sendBtn = this.el.querySelector('#send-btn');
    
    this.sttEnabled = true;
    this.ttsEnabled = true;
  }

  _listen() {
    this.toggleSttBtn.addEventListener('change', (e) => {
      this.sttEnabled = e.target.checked;
      this._updateMicState();
      if (!this.sttEnabled && !this.stsEnabled && this.stt.isRecording) {
        this.stt.toggle();
      }
    });

    this.toggleStsBtn.addEventListener('change', (e) => {
      this.stsEnabled = e.target.checked;
      this.stt.mode = e.target.checked ? 'sts' : 'stt';
      this._updateMicState();
      if (e.target.checked) {
        this.interimText.textContent = 'Voice Changer Mode Active (Bypassing AI)';
        this.interimText.style.display = 'block';
        setTimeout(() => this.interimText.style.display = 'none', 3000);
      }
    });

    this.toggleTtsBtn.addEventListener('change', (e) => {
      this.ttsEnabled = e.target.checked;
      if (!this.ttsEnabled) {
        this.tts.stop();
      }
    });

    this.toggleAgentBtn.addEventListener('change', (e) => {
      this.agentEnabled = e.target.checked;
      this._updateMicState();
      
      if (this.agentEnabled) {
        // Auto-disable other modes
        this.toggleSttBtn.checked = false;
        this.toggleStsBtn.checked = false;
        this.toggleTtsBtn.checked = false;
        this.sttEnabled = false;
        this.stsEnabled = false;
        this.ttsEnabled = false;
        
        this.interimText.textContent = 'Live Agent Mode Ready. Click Mic to Connect.';
        this.interimText.style.display = 'block';
        setTimeout(() => this.interimText.style.display = 'none', 3000);
      } else {
        if (this.agent.isActive) this.agent.stop();
      }
    });



    this.micBtn.addEventListener('click', () => {
      if (this.agentEnabled) {
        this.agent.toggle();
      } else if (this.sttEnabled || this.stsEnabled) {
        this.stt.toggle();
      }
    });
    this.replayTtsBtn.addEventListener('click', () => this.tts.replay());
    this.stopTtsBtn.addEventListener('click', () => this.tts.stop());

    this.sendBtn.addEventListener('click', () => this._sendText());
    this.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._sendText();
    });

    bus.on('stt:status', (recording) => {
      this.micBtn.classList.toggle('recording', recording);
      this.micStatus.textContent = recording ? 'Listening…' : 'Ready';
      this.waveform.style.display = recording ? 'flex' : 'none';
      if (recording) this._animateWaveform();
    });

    bus.on('stt:interim', (text) => {
      this.interimText.textContent = text;
      this.interimText.style.display = 'block';
    });

    bus.on('stt:final', (text) => {
      this.interimText.style.display = 'none';
      this._showProcessing();
      bus.emit('voice:query', text);
    });

    // ── Live Agent Event Handlers ──
    bus.on('agent:started', () => {
      this.micBtn.classList.add('recording');
      this.micStatus.textContent = 'Connected…';
      this.waveform.style.display = 'flex';
      this._animateWaveform();
    });

    bus.on('agent:stopped', () => {
      this.micBtn.classList.remove('recording');
      this.micStatus.textContent = 'Ready';
      this.waveform.style.display = 'none';
    });

    bus.on('agent:mode', (mode) => {
      // mode is 'speaking' or 'listening'
      this.micStatus.textContent = mode === 'speaking' ? 'Agent Speaking…' : 'Agent Listening…';
    });

    bus.on('query:complete', (result) => {
      this._removeProcessing();
      if (this.ttsEnabled) {
        let ttsText = result.ttsResponse || result.response || "";
        ttsText = ttsText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        this.tts.speak(ttsText);
      }
    });

    bus.on('tts:status', (speaking) => {
      if (this.stopTtsBtn) {
        this.stopTtsBtn.disabled = !speaking;
        this.stopTtsBtn.style.opacity = speaking ? '1' : '0.5';
      }
      if (this.replayTtsBtn) {
        this.replayTtsBtn.style.opacity = this.tts.currentUrl ? '1' : '0.5';
      }
    });

    bus.on('tts:stop_request', () => {
      this.tts.stop();
    });

    bus.on('agent:tts', (text) => {
      if (this.ttsEnabled) {
        this.tts.speak(text);
      }
    });

    bus.on('agent:progress', (msg) => {
      const textEl = document.getElementById('ai-processing-text');
      if (textEl) {
         textEl.innerHTML += `<br><span style="font-size: 11px; opacity: 0.8; font-family: 'DM Mono', monospace;">> ${msg}</span>`;
         this.transcriptArea.scrollTop = this.transcriptArea.scrollHeight;
      }
    });

    bus.on('stt:error', (msg) => {
      this._removeProcessing();
      this.interimText.textContent = `⚠️ STT Error: ${msg}`;
      this.interimText.style.display = 'block';
      this.interimText.style.color = '#ef4444'; // Red-500
      this.micBtn.classList.remove('recording');
      this.micStatus.textContent = 'Ready';
      this.waveform.style.display = 'none';
      
      setTimeout(() => {
        this.interimText.style.display = 'none';
        this.interimText.style.color = '';
      }, 8000);
    });
  }

  _sendText() {
    const text = this.textInput.value.trim();
    if (!text) return;
    this.textInput.value = '';
    // We don't add entry here anymore; it will be added when session updates
    // Actually, to feel responsive, we should let session manager add it or we add it and session manager saves it.
    // Let's rely on event bus from STT or send it to router directly. The router calls sessionManager.addMessage.
    // So we don't call this._addEntry directly.
    this._showProcessing();
    bus.emit('voice:query', text);
  }

  _showProcessing() {
    if (this.transcriptArea.querySelector('.inspector-empty')) {
       this.transcriptArea.innerHTML = '';
    }
    const div = document.createElement('div');
    div.className = 'transcript-entry ai animate-slide-up';
    div.id = 'ai-processing-indicator';
    div.innerHTML = `
      <div class="transcript-entry__role">🧠 AI</div>
      <div id="ai-processing-text" style="color: var(--text-tertiary); font-style: italic;">Thinking...</div>
    `;
    this.transcriptArea.appendChild(div);
    this.transcriptArea.scrollTop = this.transcriptArea.scrollHeight;
  }

  _removeProcessing() {
    const el = document.getElementById('ai-processing-indicator');
    if (el) el.remove();
  }

  _addEntry(role, text, time = new Date()) {
    // Clear empty state
    if (this.transcriptArea.querySelector('.inspector-empty')) {
      this.transcriptArea.innerHTML = '';
    }

    const entry = { role, text, time };
    this.entries.push(entry);

    // Strip thinking blocks from display and escape HTML
    let parsedText = text || "";
    if (role === 'ai') {
        // Remove <thinking>...</thinking> blocks entirely
        parsedText = parsedText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        
        // Remove the <tts> and </tts> tags (but keep the text inside them so the user reads what was spoken)
        parsedText = parsedText.replace(/<\/?tts>/gi, '');
        
        // Escape HTML to prevent broken DOM
        parsedText = parsedText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
            
        // Very basic markdown parsing
        parsedText = parsedText
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    }

    const div = document.createElement('div');
    div.className = `transcript-entry ${role} animate-slide-up`;
    div.innerHTML = `
      <div class="transcript-entry__role">${role === 'user' ? '🎤 You' : '🧠 AI'}</div>
      <div>${parsedText}</div>
      <div class="transcript-entry__time">${entry.time.toLocaleTimeString()}</div>
    `;
    this.transcriptArea.appendChild(div);
    this.transcriptArea.scrollTop = this.transcriptArea.scrollHeight;
  }

  _animateWaveform() {
    if (!this.stt.isRecording) return;
    this.waveBars.forEach(bar => {
      bar.style.height = (4 + Math.random() * 24) + 'px';
    });
    requestAnimationFrame(() => setTimeout(() => this._animateWaveform(), 80));
  }

  _updateMicState() {
    const isMicActive = this.sttEnabled || this.stsEnabled || this.agentEnabled;
    this.micBtn.disabled = !isMicActive;
    this.micBtn.style.opacity = isMicActive ? '1' : '0.5';
  }

  _listenToSessions() {
    this.sessionSelect = this.el.querySelector('#session-select');
    this.newSessionBtn = this.el.querySelector('#new-session-btn');
    this.saveSessionBtn = this.el.querySelector('#save-session-btn');
    this.deleteSessionBtn = this.el.querySelector('#delete-session-btn');

    this.newSessionBtn.addEventListener('click', () => {
      this.sessionManager.createNewSession();
    });

    this.saveSessionBtn.addEventListener('click', () => {
      const btn = this.saveSessionBtn;
      btn.textContent = '⏳';
      this.sessionManager.processPendingSessions().then((processedAny) => {
        if (processedAny === false) {
           alert("Brain sync skipped: There are no new messages to extract memories from since your last sync.");
        }
      }).finally(() => {
        btn.textContent = '💾';
      });
    });

    this.deleteSessionBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to delete this session and all its messages?')) {
        this.sessionManager.deleteSession(this.sessionManager.activeSessionId);
      }
    });

    this.sessionSelect.addEventListener('change', (e) => {
      this.sessionManager.switchSession(e.target.value);
    });

    const renderSessions = () => {
      if (!this.sessionManager || !this.sessionManager.sessions) return;
      this.sessionSelect.innerHTML = this.sessionManager.sessions.map(s => 
        `<option value="${s.id}" ${s.id === this.sessionManager.activeSessionId ? 'selected' : ''}>${s.name}</option>`
      ).join('');
    };

    bus.on('session:created', renderSessions);
    bus.on('session:updated', renderSessions);
    bus.on('session:deleted', renderSessions);
    
    bus.on('session:updated', (session) => {
       if (session.id === this.sessionManager.activeSessionId) {
          this._renderTranscript(session);
       }
    });

    bus.on('session:switched', (session) => {
      if (!session) return;
      renderSessions();
      this._renderTranscript(session);
    });
  }

  _renderTranscript(session) {
    this.transcriptArea.innerHTML = '';
    this.entries = [];
    if (!session || !session.messages || session.messages.length === 0) {
      this.transcriptArea.innerHTML = `
        <div class="inspector-empty" style="height:100%;">
          <div class="inspector-empty__icon">🧠</div>
          <div>Speak or type to begin</div>
          <div style="font-size:11px; color:var(--text-quaternary);">Your conversation will appear here</div>
        </div>
      `;
    } else {
      session.messages.forEach(m => {
        const isNumericStr = typeof m.timestamp === 'string' && /^\d+(\.\d+)?$/.test(m.timestamp);
        const ts = isNumericStr ? new Date(parseFloat(m.timestamp)) : new Date(m.timestamp);
        this._addEntry(m.role, m.content, ts);
      });
    }
  }
}
