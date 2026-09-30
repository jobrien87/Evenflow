import { useSpeechToText } from '../lib/useSpeechToText';
import Icon from './Icon';

// Drop-in dictation button for any text input/textarea: appends the
// recognized speech to whatever the caller's own value already holds.
// Renders nothing when the browser has no Web Speech API — never a
// disabled/fake control claiming a capability that isn't there.
export default function MicButton({ onTranscript, size = 15, style }) {
  const { isSupported, isListening, toggle } = useSpeechToText({
    onFinalResult: (text) => onTranscript(text),
  });

  if (!isSupported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      title={isListening ? 'Stop dictation' : 'Dictate'}
      aria-label={isListening ? 'Stop dictation' : 'Dictate'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: size + 14, height: size + 14, borderRadius: '50%', flexShrink: 0,
        border: 'none', cursor: 'pointer', padding: 0,
        background: isListening ? 'var(--danger)' : 'var(--bg-hover)',
        color: isListening ? '#fff' : 'var(--text-secondary)',
        animation: isListening ? 'mic-pulse 1.2s ease-in-out infinite' : 'none',
        ...style,
      }}
    >
      <Icon name="mic" size={size} />
    </button>
  );
}
