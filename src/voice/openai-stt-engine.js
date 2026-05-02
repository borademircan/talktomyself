/**
 * OpenAI STT Engine — Uses MediaRecorder + OpenAI's Whisper API.
 */
import { bus } from '../core/event-bus.js';

export class OpenAISttEngine {
  constructor() {
    this.supported = !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    this.stream = null;
    this.mode = 'stt'; // 'stt' or 'sts'
  }

  async start() {
    if (!this.supported || this.isRecording) return;
    if (!this.apiKey) {
      console.warn('[STT] OpenAI API key missing. Please add VITE_OPENAI_API_KEY to .env');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.stream);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        this.audioChunks = [];
        
        // Stop all tracks to release mic
        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
        }
        
        if (this.mode === 'sts') {
          bus.emit('voice:sts_request', audioBlob);
        } else {
          bus.emit('stt:interim', 'Transcribing...');
          await this._transcribe(audioBlob);
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      bus.emit('stt:status', true);
    } catch (e) {
      console.error('[STT] Setup Error', e);
      this.isRecording = false;
      bus.emit('stt:status', false);
      bus.emit('stt:error', e.message);
    }
  }

  stop() {
    if (!this.supported || !this.isRecording || !this.mediaRecorder) return;
    this.mediaRecorder.stop();
    this.isRecording = false;
    bus.emit('stt:status', false);
  }

  toggle() {
    if (this.isRecording) this.stop();
    else this.start();
  }

  async _transcribe(blob) {
    try {
      const formData = new FormData();
      // Whisper requires a filename
      formData.append('file', blob, 'audio.webm');
      formData.append('model', 'whisper-1');

      const response = await fetch(import.meta.env.BASE_URL + 'api/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: formData
      });

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('429 Too Many Requests (Check OpenAI billing/credits)');
        }
        throw new Error(`OpenAI STT Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data.text) {
        bus.emit('stt:final', data.text);
      }
    } catch (e) {
      console.error('[STT] Transcription Error', e);
      bus.emit('stt:error', e.message);
    }
  }
}
