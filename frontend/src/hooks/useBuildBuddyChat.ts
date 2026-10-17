import { useCallback, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { BuildBuddyApi, type BuddyHistoryMessage } from '../services/buildBuddyApi';
import type { PetId } from '../pets';

export interface BuddyTurn {
  id: number;
  text: string;
  imageUrl?: string;
  imageName?: string;
  reply?: string;
  error?: string;
  generationId?: string;
  method?: string;
}

export function useBuildBuddyChat(pet: PetId, authToken?: string, owner = authToken ? 'account' : 'guest') {
  const [turns, setTurns] = useState<BuddyTurn[]>([]);
  const history = useRef<{ id: number; text: string; reply?: string }[]>([]);
  const sequence = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const images = useRef<string[]>([]);
  const updateTurn = useCallback((id: number, patch: Partial<BuddyTurn>) => {
    setTurns(current => current.map(turn => turn.id === id ? { ...turn, ...patch } : turn));
  }, []);

  useEffect(() => {
    setTurns([]);
    history.current = [];
    return () => {
      requests.current.forEach(request => request.abort());
      requests.current.clear();
      images.current.forEach(url => URL.revokeObjectURL(url));
      images.current = [];
    };
  }, [owner]);

  const startTurn = (text: string, file: File | null) => {
    const id = ++sequence.current;
    history.current = [...history.current, { id, text: text || 'Image reference' }].slice(-8);
    const imageUrl = file ? URL.createObjectURL(file) : undefined;
    if (imageUrl) images.current.push(imageUrl);
    setTurns(current => [...current, { id, text, imageUrl, imageName: file?.name }]);
    posthog.capture('build_buddy_message_sent', { pet_id: pet, has_image: !!file, has_prompt: !!text.trim() });
    return id;
  };

  const requestReply = (id: number, text: string, imageBase64?: string, imageMediaType?: string) => {
    const controller = new AbortController();
    requests.current.add(controller);
    const context: BuddyHistoryMessage[] = history.current.filter(turn => turn.id < id).flatMap(turn => [
      { role: 'user' as const, text: turn.text },
      ...(turn.reply ? [{ role: 'assistant' as const, text: turn.reply }] : []),
    ]).slice(-8);
    void BuildBuddyApi.reply({ pet, prompt: text, imageBase64, imageMediaType, history: context }, authToken, controller.signal)
      .then(reply => {
        if (controller.signal.aborted) return;
        setTurns(current => current.map(turn => turn.id === id && !turn.error ? { ...turn, reply } : turn));
        history.current = history.current.map(turn => turn.id === id ? { ...turn, reply } : turn);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTurns(current => current.map(turn => turn.id === id && !turn.error
          ? { ...turn, reply: 'I couldn’t reply just now. I’ll show your build’s progress here as it arrives.' } : turn));
      }).finally(() => requests.current.delete(controller));
  };

  return { turns, startTurn, requestReply, updateTurn };
}
