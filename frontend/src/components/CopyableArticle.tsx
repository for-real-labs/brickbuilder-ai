import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy } from 'lucide-react';
import posthog from 'posthog-js';

function CopyCodeButton({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      posthog.capture('blog_code_copied', { source: 'article' });
    } catch {
      setStatus('failed');
      posthog.capture('blog_code_copy_failed', { source: 'article' });
    }
  };
  return <>
    <button type="button" className="article-copy-button" onClick={() => void copy()}>
      {status === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {status === 'copied' ? 'Copied!' : 'Copy to clipboard'}
    </button>
    <span role="status" className="article-copy-status">{status === 'failed' ? 'Could not copy. Select the text below and copy it manually.' : status === 'copied' ? 'Ready to paste.' : ''}</span>
  </>;
}

/** Content must come from the sanitized, checked-in feed importer. */
export function CopyableArticle({ content }: { content: string }) {
  const article = useRef<HTMLDivElement>(null);
  const [blocks, setBlocks] = useState<{ target: HTMLDivElement; text: string }[]>([]);
  useEffect(() => {
    const next = Array.from(article.current?.querySelectorAll('pre') ?? []).map(pre => {
      const target = document.createElement('div');
      target.className = 'article-copy-toolbar';
      pre.before(target);
      return { target, text: pre.textContent ?? '' };
    });
    setBlocks(next);
    return () => next.forEach(({ target }) => target.remove());
  }, [content]);
  return <>
    <div ref={article} className="substack-article mt-9 text-base leading-8 text-slate-700" dangerouslySetInnerHTML={{ __html: content }} />
    {blocks.map(({ target, text }, index) => createPortal(<CopyCodeButton text={text} />, target, `${content}-${index}`))}
  </>;
}
