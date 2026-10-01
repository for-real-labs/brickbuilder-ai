import { useEffect, useState } from 'react';
import { PROMPT_EXAMPLES, pickPromptExampleIndex } from '../utils/promptExamples';

export function usePromptTypewriter(enabled: boolean) {
  const [idx, setIdx] = useState(() => pickPromptExampleIndex());
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [pause, setPause] = useState(false);
  const [showCaret, setShowCaret] = useState(true);

  // Caret blinking - separate from text updates
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setShowCaret(prev => !prev);
    }, 400);
    return () => clearInterval(interval);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;               // stop updating when user is typing/focused
    if (pause) {
      const t = setTimeout(() => setPause(false), 900);
      return () => clearTimeout(t);
    }

    const phrase = PROMPT_EXAMPLES[idx];
    const speed = deleting ? 35 : 70;   // typing speed
    const nextTimer = setTimeout(() => {
      const nextLen = deleting ? text.length - 1 : text.length + 1;
      const next = phrase.slice(0, Math.max(0, nextLen));
      setText(next);
      if (!deleting && next === phrase) {
        setPause(true);
        setDeleting(true);
      } else if (deleting && next.length === 0) {
        setDeleting(false);
        setIdx(pickPromptExampleIndex(idx));
      }
    }, speed);

    return () => clearTimeout(nextTimer);
  }, [enabled, text, deleting, pause, idx]);

  const caret = enabled && showCaret ? "|" : "";
  return (text + caret).trim();
}

