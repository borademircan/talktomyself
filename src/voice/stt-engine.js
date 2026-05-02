/**
 * STT Engine — Web Speech API SpeechRecognition wrapper
 */
import { bus } from '../core/event-bus.js';

export class STTEngine {
  constructor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.recognition = null;
    this.isRecording = false;

    if (this.supported) {
      this.recognition = new SR();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = (e) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const transcript = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += transcript;
          else interim += transcript;
        }
        if (interim) bus.emit('stt:interim', interim);
        if (final) {
          bus.emit('stt:final', final);
          this.stop();
        }
      };

      this.recognition.onerror = (e) => {
        bus.emit('stt:error', e.error);
        this.isRecording = false;
        bus.emit('stt:status', false);
      };

      this.recognition.onend = () => {
        this.isRecording = false;
        bus.emit('stt:status', false);
      };
    }
  }

  start() {
    if (!this.supported || this.isRecording) return;
    try {
      this.recognition.start();
      this.isRecording = true;
      bus.emit('stt:status', true);
    } catch (e) { console.error('[STT]', e); }
  }

  stop() {
    if (!this.supported || !this.isRecording) return;
    this.recognition.stop();
    this.isRecording = false;
    bus.emit('stt:status', false);
  }

  toggle() {
    if (this.isRecording) this.stop();
    else this.start();
  }
}
