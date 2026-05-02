/**
 * ElevenLabs STS Engine — Speech-to-Speech Voice Changer
 */
import { bus } from '../core/event-bus.js';

export class ElevenLabsStsEngine {
  constructor() {
    this.apiKey = import.meta.env.VITE_ELEVENLABS_API_KEY;
    this.voiceId = import.meta.env.VITE_ELEVENLABS_VOICE_ID;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.currentSource = null;
    this.supported = !!this.apiKey && !!this.voiceId;
  }

  async convertAndPlay(audioBlob) {
    console.log('[STS] convertAndPlay triggered with blob:', audioBlob);
    
    if (!this.supported) {
      console.warn('[STS] ElevenLabs API Key or Voice ID missing.');
      bus.emit('stt:error', 'ElevenLabs API credentials missing.');
      return;
    }

    try {
      console.log('[STS] Emitting status events and building FormData...');
      bus.emit('stt:interim', 'Converting Voice (STS)...');
      bus.emit('tts:status', true);

      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');
      formData.append('model_id', 'eleven_multilingual_sts_v2');

      console.log(`[STS] Sending POST to https://api.elevenlabs.io/v1/speech-to-speech/${this.voiceId}`);
      const response = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${this.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey
        },
        body: formData
      });

      console.log(`[STS] Response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[STS] API Error details:', errorText);
        throw new Error(`ElevenLabs STS Error: ${response.statusText} - ${errorText}`);
      }

      console.log('[STS] Parsing audio buffer...');
      const arrayBuffer = await response.arrayBuffer();
      console.log('[STS] Buffer parsed, size:', arrayBuffer.byteLength);
      await this._playAudioBuffer(arrayBuffer);
    } catch (e) {
      console.error('[STS] Conversion Error', e);
      bus.emit('stt:error', `STS Failed: ${e.message}`);
      bus.emit('tts:status', false);
    }
  }

  async _playAudioBuffer(arrayBuffer) {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (this.currentSource) {
      this.currentSource.stop();
      this.currentSource = null;
    }

    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    source.onended = () => {
      this.currentSource = null;
      bus.emit('tts:status', false);
      bus.emit('stt:interim', ''); // Clear the "Converting" message
      // Hide interim text in UI
      const interimText = document.getElementById('interim-text');
      if (interimText) interimText.style.display = 'none';
    };

    this.currentSource = source;
    source.start(0);
  }

  stop() {
    if (this.currentSource) {
      this.currentSource.stop();
      this.currentSource = null;
    }
    bus.emit('tts:status', false);
  }
}
