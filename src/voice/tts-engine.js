/**
 * TTS Engine — Web Speech API SpeechSynthesis wrapper
 */
import { bus } from '../core/event-bus.js';

export class TTSEngine {
  constructor() {
    this.supported = 'speechSynthesis' in window;
    this.speaking = false;
  }

  speak(text) {
    if (!this.supported) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.lang = 'en-US';

    // Pick a good voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Samantha') || v.name.includes('Google') || v.name.includes('Daniel'));
    if (preferred) utterance.voice = preferred;

    utterance.onstart = () => { this.speaking = true; bus.emit('tts:status', true); };
    utterance.onend = () => { this.speaking = false; bus.emit('tts:status', false); };
    utterance.onerror = () => { this.speaking = false; bus.emit('tts:status', false); };

    window.speechSynthesis.speak(utterance);
  }

  stop() {
    if (!this.supported) return;
    window.speechSynthesis.cancel();
    this.speaking = false;
    bus.emit('tts:status', false);
  }
}
