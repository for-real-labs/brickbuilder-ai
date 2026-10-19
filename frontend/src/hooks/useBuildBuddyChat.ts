import { useCallback, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { BuildBuddyApi, type BuddyHistoryMessage, type BuddyReplyRequest } from '../services/buildBuddyApi';
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
  kind?: 'gift' | 'upload';
  buildPrompt?: string;
}

export function useBuildBuddyChat(pet: PetId, authToken?: string, owner = authToken ? 'account' : 'guest') {
  const [turns, setTurns] = useState<BuddyTurn[]>([]);
  const history = useRef<{ id: number; text: string; reply?: string }[]>([]);
  const giftStartId = useRef(0);
  const sequence = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const images = useRef<string[]>([]);
  const [routing, setRouting] = useState(false);
  const routingController = useRef<AbortController | null>(null);
  const updateTurn = useCallback((id: number, patch: Partial<BuddyTurn>) => {
    setTurns(current => current.map(turn => turn.id === id ? { ...turn, ...patch } : turn));
    if (patch.reply) history.current = history.current.map(turn => turn.id === id ? { ...turn, reply: patch.reply } : turn);
  }, []);

  const resetConversation = useCallback(() => {
    routingController.current?.abort();
    requests.current.forEach(request => request.abort());
    requests.current.clear();
    routingController.current = null;
    images.current.forEach(url => URL.revokeObjectURL(url));
    images.current = [];
    history.current = [];
    giftStartId.current = 0;
    setRouting(false);
    setTurns([]);
  }, []);

  useEffect(() => {
    setTurns([]);
    history.current = [];
    routingController.current = null;
    setRouting(false);
    return () => {
      routingController.current = null;
      history.current = [];
      requests.current.forEach(request => request.abort());
      requests.current.clear();
      images.current.forEach(url => URL.revokeObjectURL(url));
      images.current = [];
    };
  }, [owner]);

  const startTurn = (text: string, file: File | null, kind?: BuddyTurn['kind']) => {
    const id = ++sequence.current;
    history.current = [...history.current, { id, text: text || 'Image reference' }].slice(-16);
    const imageUrl = file ? URL.createObjectURL(file) : undefined;
    if (imageUrl) images.current.push(imageUrl);
    setTurns(current => [...current, { id, text, imageUrl, imageName: file?.name, kind }]);
    posthog.capture('build_buddy_message_sent', { pet_id: pet, has_image: !!file, has_prompt: !!text.trim() });
    return id;
  };

  const routeMessage = async (text: string, file: File | null, modelName?: string, giftPlanning = false) => {
    if (routingController.current) return;
    const controller = new AbortController();
    routingController.current = controller;
    requests.current.add(controller);
    setRouting(true);
    const context: BuddyHistoryMessage[] = history.current.flatMap(turn => [
      { role: 'user' as const, text: turn.text },
      ...(turn.reply ? [{ role: 'assistant' as const, text: turn.reply }] : []),
    ]).slice(-8);
    const id = startTurn(text, file);
    try {
      const decision = await BuildBuddyApi.classify({ prompt: text, hasImage: !!file, modelName, giftPlanning, history: context }, authToken, controller.signal);
      if (controller.signal.aborted) return;
      posthog.capture('build_buddy_message_routed', { pet_id: pet, intent: decision.intent, confidence: decision.confidence, has_image: !!file });
      return { ...decision, id };
    } catch {
      if (!controller.signal.aborted) {
        updateTurn(id, { reply: 'I missed that. Can you try again?' });
        posthog.capture('build_buddy_message_routing_failed', { pet_id: pet });
      }
    } finally {
      requests.current.delete(controller);
      if (routingController.current === controller) {
        routingController.current = null;
        setRouting(false);
      }
    }
  };

  const requestReply = (id: number, text: string, imageBase64?: string, imageMediaType?: string, intent?: BuddyReplyRequest['intent']) => {
    if (!history.current.some(turn => turn.id === id)) return;
    const controller = new AbortController();
    requests.current.add(controller);
    const context: BuddyHistoryMessage[] = history.current.filter(turn => turn.id < id).flatMap(turn => [
      { role: 'user' as const, text: turn.text },
      ...(turn.reply ? [{ role: 'assistant' as const, text: turn.reply }] : []),
    ]).slice(-8);
    void BuildBuddyApi.reply({ pet, prompt: text, imageBase64, imageMediaType, history: context, ...(intent ? { intent } : {}) }, authToken, controller.signal)
      .then(reply => {
        if (controller.signal.aborted) return;
        setTurns(current => current.map(turn => turn.id === id && !turn.error ? { ...turn, reply } : turn));
        history.current = history.current.map(turn => turn.id === id ? { ...turn, reply } : turn);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTurns(current => current.map(turn => turn.id === id && !turn.error
          ? { ...turn, reply: 'I can’t chat right now. Please try again.' } : turn));
      }).finally(() => requests.current.delete(controller));
  };

  const requestGiftReply = async (id: number, text: string, fresh = false) => {
    if (!history.current.some(turn => turn.id === id)) return;
    if (fresh) giftStartId.current = id;
    const controller = new AbortController();
    requests.current.add(controller);
    const context: BuddyHistoryMessage[] = history.current.filter(turn => turn.id >= giftStartId.current && turn.id < id).flatMap(turn => [
      { role: 'user' as const, text: turn.text },
      ...(turn.reply ? [{ role: 'assistant' as const, text: turn.reply }] : []),
    ]).slice(-16);
    try {
      const result = await BuildBuddyApi.planGift({ pet, prompt: text, history: context }, authToken, controller.signal);
      if (!controller.signal.aborted) updateTurn(id, { reply: result.reply, buildPrompt: result.buildPrompt });
    } catch {
      if (!controller.signal.aborted) updateTurn(id, { reply: 'I missed your answer. Can you send it again?' });
    } finally { requests.current.delete(controller); }
  };

  return { turns, startTurn, routeMessage, routing, requestReply, requestGiftReply, updateTurn, resetConversation };
}
