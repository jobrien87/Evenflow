import { useEffect, useRef, useState } from 'react';

// Talk-to-text everywhere in the app runs on the browser's own Web
// Speech API — no server round-trip, no new backend, honest
// degradation (isSupported: false) on browsers that don't implement it.
export function useSpeechToText({ onFinalResult } = {}) {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const recognitionRef = useRef(null);
  const onFinalResultRef = useRef(onFinalResult);
  onFinalResultRef.current = onFinalResult;

  const SpeechRecognitionImpl = typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;
  const isSupported = !!SpeechRecognitionImpl;

  useEffect(() => () => recognitionRef.current?.stop(), []);

  function start() {
    if (!isSupported || isListening) return;
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) onFinalResultRef.current?.(text);
        } else {
          interim += result[0].transcript;
        }
      }
      setInterimText(interim);
    };
    recognition.onerror = () => {
      setIsListening(false);
      setInterimText('');
    };
    recognition.onend = () => {
      setIsListening(false);
      setInterimText('');
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }

  function stop() {
    recognitionRef.current?.stop();
    setIsListening(false);
  }

  function toggle() {
    if (isListening) stop();
    else start();
  }

  return { isSupported, isListening, interimText, start, stop, toggle };
}
