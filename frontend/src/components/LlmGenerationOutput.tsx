import React, { useEffect, useState } from 'react';
import { LlmToBricksApiService } from '../services/llmToBricksApi';
import { LlmDesignNotes } from './LlmDesignNotes';

export function LlmGenerationOutput({ generationId, active }: { generationId: string; active: boolean }) {
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState<string | undefined>('');
  const [reconnecting, setReconnecting] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 1_000;
    setNotes('');
    setSummary('');
    setFinished(false);
    setReconnecting(false);
    const connect = async () => {
      let complete = false;
      try {
        complete = await LlmToBricksApiService.watchOutput(generationId, output => {
          if (controller.signal.aborted) return;
          // Each event is a full snapshot, so reconnecting cannot duplicate text.
          setNotes(output.text);
          setSummary(typeof output.summary === 'string' ? output.summary : undefined);
          setFinished(['completed', 'failed', 'cancelled'].includes(output.status));
          setReconnecting(false);
          retryDelay = 1_000;
        }, controller.signal);
      } catch {
        // A disconnected observer does not mean the background build failed.
      }
      if (!complete && !controller.signal.aborted) {
        setReconnecting(true);
        timer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [generationId]);

  return <div className="mt-3 min-w-0">
    <LlmDesignNotes notes={notes} summary={summary} isThinking={active && !finished} />
    {reconnecting && <p role="status" className="mt-2 text-xs text-slate-500">Reconnecting to live output… Your build keeps running.</p>}
  </div>;
}
