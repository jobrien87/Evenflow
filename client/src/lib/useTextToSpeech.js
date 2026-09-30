import { useEffect, useState } from 'react';

const VOICE_STORAGE_KEY = 'ed_roleplay_voice_uri';

// Reply text-to-speech, also on the browser's own Web Speech API — the
// one place a person picks which real installed system voice ED's
// roleplay replies (and, wherever else wired in, other read-aloud text)
// use, persisted per-browser like every other personalization setting
// in this app.
export function useTextToSpeech() {
  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [voices, setVoices] = useState([]);
  const [voiceURI, setVoiceURI] = useState(() => {
    try {
      return localStorage.getItem(VOICE_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!isSupported) return;
    function loadVoices() {
      setVoices(window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')));
    }
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [isSupported]);

  function selectVoice(uri) {
    setVoiceURI(uri);
    try {
      localStorage.setItem(VOICE_STORAGE_KEY, uri);
    } catch {
      // per-viewer convenience only — fine if storage is unavailable
    }
  }

  function speak(text) {
    if (!isSupported || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = voices.find((v) => v.voiceURI === voiceURI);
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }

  function stop() {
    if (isSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  return { isSupported, voices, voiceURI, selectVoice, speak, stop, speaking };
}
