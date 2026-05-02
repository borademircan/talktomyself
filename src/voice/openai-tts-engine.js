/**
 * OpenAI TTS Engine — Uses OpenAI's v1/audio/speech API for high-quality TTS.
 */
import { bus } from '../core/event-bus.js';

export class OpenAITtsEngine {
  constructor() {
    this.supported = true;
    this.speaking = false;
    this.audioElement = null;
    this.apiKey = import.meta.env.VITE_OPENAI_API_KEY;
  }

  async speak(text) {
    if (!this.apiKey) {
      console.warn('[TTS] OpenAI API key missing. Please add VITE_OPENAI_API_KEY to .env');
      return;
    }

    this.stop(); // Stop any currently playing audio

    try {
      this.speaking = true;
      bus.emit('tts:status', true);

      const response = await fetch(import.meta.env.BASE_URL + 'api/openai/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: 'nova', // Nova is an energetic, vibrant, and natural female voice
          response_format: 'mp3'
        })
      });

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('429 Too Many Requests (Check OpenAI billing/credits)');
        }
        throw new Error(`OpenAI TTS Error: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      this.audioElement = new Audio(url);
      
      this.audioElement.onended = () => {
        this.speaking = false;
        bus.emit('tts:status', false);
        URL.revokeObjectURL(url);
      };
      
      this.audioElement.onerror = () => {
        this.speaking = false;
        bus.emit('tts:status', false);
        URL.revokeObjectURL(url);
      };

      await this.audioElement.play();
    } catch (e) {
      console.error('[TTS]', e);
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
