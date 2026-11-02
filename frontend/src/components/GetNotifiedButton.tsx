import React, { useEffect } from 'react';
import posthog from 'posthog-js';
import { PetChatMessage } from './PetCompanion';

export function GetNotifiedButton({ generationId, promptOnStart = false, onPromptShown }: {
  generationId: string; promptOnStart?: boolean; onPromptShown?: () => void;
}) {
  useEffect(() => {
    if (promptOnStart) onPromptShown?.();
    posthog.capture('generation_email_notification_notice_shown', { generation_id: generationId });
  }, [generationId]);
  return <div className="pet-notification-conversation"><PetChatMessage><p role="status">You will receive an email when it's ready. You can safely leave this window</p></PetChatMessage></div>;
}
