/**
 * ElevenLabs TTS Engine
 */
import { bus } from '../core/event-bus.js';
import { GoogleTtsEngine } from './google-tts-engine.js';

export class ElevenLabsTtsEngine {
  constructor() {
    this.supported = true;
    this.speaking = false;
    this.audioElement = null;
    this.apiKey = import.meta.env.VITE_ELEVENLABS_API_KEY;
    this.voiceId = import.meta.env.VITE_ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Default to Rachel if none provided
    this.fallbackEngine = new GoogleTtsEngine();
    this.usingFallback = false;
  }

  async speak(text) {
    const cleanText = text.replace(/\*/g, '').trim();
    console.log(`[TTS] speak() called with text: "${cleanText.substring(0, 30)}..."`);
    if (!this.apiKey) {
      console.warn('[TTS] ElevenLabs API key missing. Please add VITE_ELEVENLABS_API_KEY to .env');
      return;
    }

    if (!this.voiceId) {
      console.warn('[TTS] ElevenLabs Voice ID missing. Please add VITE_ELEVENLABS_VOICE_ID to .env');
      return;
    }

    this.stop(true); // Stop any currently playing audio and clear memory

    try {
      this.speaking = true;
      bus.emit('tts:status', true);
      this.usingFallback = false;

      console.log(`[TTS] Fetching from ElevenLabs... API Key length: ${this.apiKey.length}, starts with: ${this.apiKey.substring(0, 5)}`);
      // Use local proxy to avoid 401 Unauthorized caused by Origin/CORS restrictions
      const response = await fetch(`/api/elevenlabs/v1/text-to-speech/${this.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey.trim(), // added trim() just in case
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model_id: 'eleven_v3',
          text: cleanText,
          voice_settings: {
            similarity_boost: 0.75,
            stability: 0.5
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[TTS] ElevenLabs failed with status ${response.status}. Falling back to Google TTS... Error: ${errText}`);
        this.usingFallback = true;
        
        // Pass the request off to the Google TTS fallback engine
        await this.fallbackEngine.speak(cleanText);
        
        // Google TTS handles its own 'speaking' flag and bus emits
        this.speaking = false; 
        return;
      }

      console.log(`[TTS] Got OK response. Converting to blob...`);
      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      
      this.currentUrl = url;
      this.audioElement = new Audio(url);
      
      this.audioElement.onended = () => {
        console.log(`[TTS] Audio playback ended natively.`);
        this.speaking = false;
        bus.emit('tts:status', false);
      };
      
      this.audioElement.onerror = (e) => {
        console.error(`[TTS] AudioElement onError!`, e);
        this.speaking = false;
        bus.emit('tts:status', false);
      };

      console.log(`[TTS] Calling audioElement.play()...`);
      this.audioElement.play()
        .then(() => {
          console.log(`[TTS] audioElement.play() promise resolved successfully!`);
        })
        .catch(e => {
          console.error(`[TTS] audioElement.play() promise rejected:`, e);
          this.speaking = false;
          bus.emit('tts:status', false);
        });
    } catch (e) {
      console.error('[TTS] Error:', e);
      this.speaking = false;
      bus.emit('tts:status', false);
    }
  }

  replay() {
    if (this.usingFallback) {
      this.fallbackEngine.replay();
      return;
    }
    
    if (!this.audioElement || !this.currentUrl) return;
    this.stop(); // Pause if currently playing
    this.speaking = true;
    bus.emit('tts:status', true);
    this.audioElement.play().catch(e => {
      console.error(`[TTS] Replay failed:`, e);
      this.speaking = false;
      bus.emit('tts:status', false);
    });
  }

  stop(clearMemory = false) {
    if (this.usingFallback) {
      this.fallbackEngine.stop(clearMemory);
    }
    
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      if (clearMemory) {
        this.audioElement.removeAttribute('src');
        this.audioElement.load();
        this.audioElement = null;
      }
    }
    if (clearMemory && this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    if (this.speaking) {
      this.speaking = false;
      bus.emit('tts:status', false);
    }
  }
}
