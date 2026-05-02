/**
 * Google TTS Engine — Uses Google Cloud Text-to-Speech API for high-quality voices (e.g. Journey/Neural2).
 */
import { bus } from '../core/event-bus.js';

export class GoogleTtsEngine {
  constructor() {
    this.supported = true;
    this.speaking = false;
    this.audioElement = null;
  }

  async speak(text) {
    this.stop(); // Stop any currently playing audio

    try {
      this.speaking = true;
      bus.emit('tts:status', true);

      const response = await fetch(import.meta.env.BASE_URL + 'api/google-tts/v1/text:synthesize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: {
            text: text.replace(/\[.*?\]/g, '').replace(/\*/g, '').trim()
          },
          voice: {
            languageCode: 'en-US',
            name: 'en-US-Journey-F' // High quality Journey voice
          },
          audioConfig: {
            audioEncoding: 'MP3'
          }
        })
      });

      if (!response.ok) {
        const errBody = await response.text(); throw new Error(`Google TTS Error: ${response.status} ${response.statusText} - ${errBody}`);
      }

      const data = await response.json();
      
      // Google TTS returns a base64 encoded string in `audioContent`
      // We need to convert this base64 string to a Blob to play it
      const binaryString = window.atob(data.audioContent);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/mp3' });
      
      if (this.currentUrl) {
        URL.revokeObjectURL(this.currentUrl);
      }
      this.currentUrl = URL.createObjectURL(blob);
      
      this.audioElement = new Audio(this.currentUrl);
      
      this.audioElement.onended = () => {
        this.speaking = false;
        bus.emit('tts:status', false);
      };
      
      this.audioElement.onerror = () => {
        this.speaking = false;
        bus.emit('tts:status', false);
      };

      await this.audioElement.play();
    } catch (e) {
      console.error('[TTS]', e);
      this.speaking = false;
      bus.emit('tts:status', false);
    }
  }

  async replay() {
    if (!this.currentUrl) return;
    this.stop();
    
    try {
      this.speaking = true;
      bus.emit('tts:status', true);
      
      this.audioElement = new Audio(this.currentUrl);
      
      this.audioElement.onended = () => {
        this.speaking = false;
        bus.emit('tts:status', false);
      };
      
      this.audioElement.onerror = () => {
        this.speaking = false;
        bus.emit('tts:status', false);
      };

      await this.audioElement.play();
    } catch (e) {
      console.error('[TTS Replay]', e);
      this.speaking = false;
      bus.emit('tts:status', false);
    }
  }

  stop() {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.audioElement = null;
    }
    if (this.speaking) {
      this.speaking = false;
      bus.emit('tts:status', false);
    }
  }
}
