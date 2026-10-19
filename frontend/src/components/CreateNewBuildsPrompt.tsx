import React from 'react';
import { ArrowUpRight, Box, Loader2 } from 'lucide-react';
import posthog from 'posthog-js';
import type { GenerationActivity } from '../hooks/useGenerationActivity';
import type { GenerationWithOrder } from '../services/getUserGenerationsApi';
import { getGeneratedModelPath } from '../utils/generationRoutes';
import { PetChatMessage } from './PetCompanion';

export function CreateNewBuildsPrompt({ processing, completed, page, pageSize, onBack, onView, onMore }: {
  processing: GenerationActivity[];
  completed: GenerationWithOrder[];
  page: number;
  pageSize: number;
  onBack: () => void;
  onView: (id: string) => void;
  onMore: () => void;
}) {
  const completedCount = completed.length;
  return <PetChatMessage>
    <p>{processing.length || completedCount ? 'Here are your builds.' : 'You don’t have any builds yet.'}</p>
    {(processing.length > 0 || completedCount > 0) && <>
      <ul className="pet-completed-builds pet-current-builds" aria-label="Your current builds">
        {processing.map(row => <li key={row.id} className="pet-build-list-row">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          <span>{row.name || row.prompt || 'Your build'}<small>Processing</small></span>
        </li>)}
        {completed.slice(page * pageSize, (page + 1) * pageSize).map(row => <li key={row.id}>
          <a href={getGeneratedModelPath(row.id, true)} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            posthog.capture('landing_create_new_build_viewed', { generation_id: row.id });
            onView(row.id);
          }}>
            <span className="pet-completed-build-preview">{row.preview_image_url || row.processed_image_url || row.external_image_url
              ? <img src={row.preview_image_url || row.processed_image_url || row.external_image_url} alt="" loading="lazy" /> : <Box size={32} aria-hidden="true" />}</span>
            <span className="pet-completed-build-title">{row.name || row.prompt || 'Your build'}<span>View model <ArrowUpRight size={14} aria-hidden="true" /></span></span>
          </a>
        </li>)}
      </ul>
      {(page + 1) * pageSize < completedCount && <div className="pet-chat-actions pet-more-builds">
        <span>Want to view more?</span>
        <button type="button" className="pet-chat-action" onClick={() => {
          posthog.capture('landing_recent_builds_more_clicked', { page: page + 1, completed_count: completedCount });
          onMore();
        }}>Yes, show more</button>
      </div>}
    </>}
    <button type="button" className="pet-chat-action" onClick={onBack}>Back</button>
  </PetChatMessage>;
}
