import { useRef, useState } from 'react';
import Icon from './Icon';

// A generic click-or-drag file box. Fires onFile(file) once a file is
// picked/dropped — parsing/uploading/result display is the caller's job,
// since different callers need different result shapes.
export default function FileDropzone({ onFile, accept, label = 'Click to upload, or drag a file here', hint, disabled }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(fileList) {
    const file = fileList && fileList[0];
    if (file) onFile(file);
  }

  return (
    <div
      style={s.box(dragOver, disabled)}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
        disabled={disabled}
        style={s.hiddenInput}
      />
      <Icon name="upload" size={22} style={{ color: 'var(--text-muted)', marginBottom: 8 }} />
      <div style={s.label}>{label}</div>
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  );
}

const s = {
  box: (dragOver, disabled) => ({
    border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--border-strong)'}`,
    borderRadius: 'var(--radius-md)',
    padding: '28px 16px',
    textAlign: 'center',
    cursor: disabled ? 'default' : 'pointer',
    background: dragOver ? 'var(--bg-elevated)' : 'var(--bg-sunken)',
    opacity: disabled ? 0.6 : 1,
    transition: 'border-color 0.15s var(--ease-standard), background 0.15s var(--ease-standard)',
  }),
  hiddenInput: { display: 'none' },
  label: { fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 },
  hint: { fontSize: 11, color: 'var(--text-muted)', marginTop: 4 },
};
