import React, { useState } from 'react';
import { Box, ArrowUpRight } from 'lucide-react';
import posthog from 'posthog-js';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import { PetChatMessage } from './PetCompanion';

/** Showing previews does not acknowledge a build; its viewer owns that receipt. */
export function BuddyCompletedBuilds({ onView }: { onView?: (id: string) => void }) {
  const { notifications } = useGenerationNotifications();
  const [showBuilds, setShowBuilds] = useState(false);
  const completed = notifications.filter(model => !model.seen && model.status === 'completed');
  if (!completed.length) return null;

  return <PetChatMessage state="celebrating">
    <p>{completed.length === 1 ? 'Your build is ready!' : `Your ${completed.length} builds are ready!`} Want to see {completed.length === 1 ? 'it' : 'them'}?</p>
    {!showBuilds ? <button type="button" className="pet-chat-action" onClick={() => {
      setShowBuilds(true);
      posthog.capture('build_buddy_completed_builds_shown', { unread_count: completed.length });
    }}>Yes, show me</button> : <ul className="pet-completed-builds" aria-label="Completed builds">
      {completed.map(model => <li key={model.id}>
        <a href={`/?id=${encodeURIComponent(model.id)}&exact=1`} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          posthog.capture('build_buddy_completed_build_clicked', { generation_id: model.id });
          if (onView) { event.preventDefault(); onView(model.id); }
        }}>
          <span className="pet-completed-build-preview">{model.image_url
            ? <img src={model.image_url} alt={`Preview of ${model.prompt}`} loading="lazy" />
            : <Box size={32} aria-hidden="true" />}</span>
          <span className="pet-completed-build-title">{model.prompt}<span>View model <ArrowUpRight size={14} aria-hidden="true" /></span></span>
        </a>
      </li>)}
    </ul>}
  </PetChatMessage>;
}
