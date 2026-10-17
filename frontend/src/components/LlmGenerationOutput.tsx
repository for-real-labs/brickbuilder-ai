import React, { useEffect, useState } from 'react';
import { LlmToBricksApiService } from '../services/llmToBricksApi';
import { PetChatMessage } from './PetCompanion';
import { BUILD_FAILURE_MESSAGE, summarizeBuildProgress } from '../utils/buildProgress';

export function LlmGenerationOutput({ generationId, active, status }: { generationId: string; active: boolean; status?: string }) {
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState<string | undefined>('');
  const [reconnecting, setReconnecting] = useState(false);
  const [finished, setFinished] = useState(false);
  const [outputStatus, setOutputStatus] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 1_000;
    setNotes('');
    setSummary('');
    setFinished(false);
    setOutputStatus('');
    setReconnecting(false);
    if (!active) return () => controller.abort();
    const connect = async () => {
      let complete = false;
      try {
        complete = await LlmToBricksApiService.watchOutput(generationId, output => {
          if (controller.signal.aborted) return;
          // Each event is a full snapshot, so reconnecting cannot duplicate text.
          setNotes(output.text);
          setSummary(typeof output.summary === 'string' ? output.summary : undefined);
          setFinished(['completed', 'failed', 'cancelled'].includes(output.status));
          setOutputStatus(output.status);
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
  }, [generationId, active]);

  const currentStatus = status && ['completed', 'failed', 'cancelled'].includes(status) ? status : outputStatus;
  const activity = summary === undefined ? summarizeBuildProgress(notes, '') : summary.trim();
  const update = currentStatus === 'completed' ? 'Look what we made! Your build is ready.'
    : currentStatus === 'cancelled' ? 'I’ve stopped this build. We can try another idea whenever you’re ready.'
    : currentStatus === 'failed' ? BUILD_FAILURE_MESSAGE
    : activity ? `I’m ${activity.charAt(0).toLowerCase() + activity.slice(1).replace(/[.!…]+$/, '')}…`
    : 'I’m getting your build ready. I’ll share updates here as I work.';
  return <PetChatMessage state={currentStatus === 'completed' ? 'celebrating' : active && !finished ? 'building' : 'idle'}>
    <p role="status" className={active && !finished ? 'build-thinking-shimmer' : undefined}>{update}</p>
    {currentStatus === 'completed' && <a className="pet-chat-action relative z-20" href={`/generated-model?id=${encodeURIComponent(generationId)}&exact=1`}>View model</a>}
    {reconnecting && active && !finished && <p className="pet-chat-meta">I’m reconnecting to live updates. Your build keeps running.</p>}
  </PetChatMessage>;
}
