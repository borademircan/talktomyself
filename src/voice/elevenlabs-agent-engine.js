import { bus } from '../core/event-bus.js';
import { Conversation } from '@elevenlabs/client';

export class ElevenLabsAgentEngine {
  constructor(router) {
    this.router = router;
    this.agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID;
    this.apiKey = import.meta.env.VITE_ELEVENLABS_API_KEY;
    this.conversation = null;
    this.isActive = false;
    this.agentPromptOverride = '';
  }

  get supported() {
    return !!this.agentId;
  }

  async init() {
    this.isInitialized = true;
    
    // Prefetch agent prompt to avoid async delay during start() which breaks browser autoplay
    try {
      const [agentRes, personaRes] = await Promise.all([
        fetch('/agent.md'),
        fetch('/persona.md')
      ]);
      const agentText = await agentRes.text();
      const personaText = await personaRes.text();
      this.agentPromptOverride = `${agentText}\n\n${personaText}`;
    } catch (err) {
      console.warn('[Agent] Could not load agent.md or persona.md', err);
    }
  }

  async start() {
    if (!this.supported) {
      console.warn('[Agent] ElevenLabs Agent ID missing.');
      bus.emit('agent:error', 'ElevenLabs Agent ID missing.');
      return;
    }
    
    if (this.isActive) return;

    try {
      console.log(`[Agent] Starting conversation with Agent ID: ${this.agentId}`);
      
      const sessionConfig = {
        agentId: this.agentId,
        connectionType: 'websocket', // Required to bypass WebRTC hangs
        overrides: {
          agent: {
            prompt: {
              prompt: this.agentPromptOverride
            }
          }
        },
        clientTools: {
          queryVectorBrain: async (parameters) => {
            console.log('[Agent Tool] queryVectorBrain called with:', parameters);
            if (!this.router || !this.router.vdb) return "Error: Vector brain not connected.";
            try {
              const query = parameters.query || "";
              const results = await this.router.vdb.search(query, 5);
              
              if (!results || results.length === 0) {
                return "No relevant memories found.";
              }
              
              const memories = results.map(r => `[From ${r.domain || 'memory'}]: ${r.text}`).join('\n---\n');
              return memories;
            } catch (err) {
              console.error("[Agent Tool Error]", err);
              return "Failed to access vector brain.";
            }
          }
        },
        onConnect: () => {
          console.log('[Agent] Connected to ElevenLabs (BAREBONES WEBSOCKET)');
          this.isActive = true;
          bus.emit('agent:started');
        },
        onDisconnect: () => {
          console.log('[Agent] Disconnected');
          this.isActive = false;
          this.conversation = null;
          bus.emit('agent:stopped');
        },
        onError: (error) => {
          console.error('[Agent] Error:', error);
          this.isActive = false;
          bus.emit('agent:error', error);
        },
        onModeChange: (mode) => {
          console.log('[Agent] Mode change:', mode);
          bus.emit('agent:mode', mode);
        },
        onMessage: (msg) => {
          console.log('[Agent] Message received:', msg);
        },
        onAudio: (base64) => {
          console.log('[Agent] Audio chunk received! Length:', base64.length);
        },
        onDebug: (info) => {
          // Log only non-audio high-level debug info to avoid spam
          if (info && info.type !== 'audio') {
            console.log('[Agent] Debug:', info);
          }
        }
      };

      console.log('[Agent] Starting minimal session via WebSocket...');
      
      // Ensure AudioContext is unlocked before the async delay
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const unlockCtx = new AudioContext();
          await unlockCtx.resume();
          console.log('[Agent] AudioContext unlocked successfully');
        }
      } catch (e) {
        console.warn('[Agent] Could not pre-unlock AudioContext', e);
      }

      this.conversation = await Conversation.startSession(sessionConfig);
      
      // Force volume to max
      try {
        if (this.conversation && typeof this.conversation.setVolume === 'function') {
          this.conversation.setVolume({ volume: 1 });
          console.log('[Agent] Volume forced to 1');
        }
      } catch (e) {
        console.warn('[Agent] Failed to set volume:', e);
      }

      // ----------------------------------------------------
      // DIAGNOSTIC & FORCE PLAYBACK BLOCK
      // ----------------------------------------------------
      try {
        if (this.conversation.output && this.conversation.output.context) {
          const ctx = this.conversation.output.context;
          console.log('[Agent] Internal AudioContext state before resume:', ctx.state);
          if (ctx.state === 'suspended') {
            await ctx.resume();
            console.log('[Agent] Internal AudioContext state AFTER resume:', ctx.state);
          }
        }
        
        // Find any hidden audio elements and force them to play
        const audioEls = document.querySelectorAll('audio');
        console.log(`[Agent] Found ${audioEls.length} <audio> elements in the DOM.`);
        audioEls.forEach((el, index) => {
          if (el.paused) {
            console.log(`[Agent] Audio element ${index} is paused, forcing play()`);
            el.play().then(() => {
              console.log(`[Agent] Audio element ${index} successfully started playing.`);
            }).catch(err => {
              console.warn(`[Agent] Audio element ${index} failed to play:`, err);
            });
          } else {
            console.log(`[Agent] Audio element ${index} is already playing.`);
          }
        });
      } catch (err) {
        console.warn('[Agent] Diagnostic block error:', err);
      }
      // ----------------------------------------------------
      
    } catch (e) {
      console.error('[Agent] Failed to start session:', e);
      this.isActive = false;
      bus.emit('agent:error', e.message);
    }
  }

  async stop() {
    if (this.conversation && this.isActive) {
      console.log('[Agent] Ending session...');
      await this.conversation.endSession();
      this.conversation = null;
      this.isActive = false;
      bus.emit('agent:stopped');
    }
  }

  toggle() {
    if (this.isActive) {
      this.stop();
    } else {
      this.start();
    }
  }
}
