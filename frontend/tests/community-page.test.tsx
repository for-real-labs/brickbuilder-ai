import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
  },
}));

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: { access_token: 'tok' },
    user: { id: 'user-1' },
    userProfile: { credits: 4 },
    isSupabaseConfigured: true,
  }),
}));

vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/components/LoginModal', () => ({ default: () => null }));

import CommunityPage from '../src/pages/CommunityPage';
import { GetCommunityGenerationsApiService } from '../src/services/getCommunityGenerationsApi';
import { ToggleGenerationLikeApiService } from '../src/services/toggleGenerationLikeApi';

describe('CommunityPage', () => {
  it('likes a community model from the grid without navigating away', async () => {
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({
      generations: [{
        id: 'generation-1',
        user_id: 'owner-1',
        user_type: 'authenticated',
        prompt: 'castle',
        name: 'Castle',
        detail_level: 10,
        endpoint: 'llm',
        created_at: '2026-09-26T00:00:00Z',
        status: 'completed',
        preview_image_url: 'https://example.com/model.png',
        username: 'builder',
        like_count: 2,
        viewer_has_liked: false,
      }],
      total_count: 1,
      has_more: false,
    });
    const toggleLike = vi.spyOn(ToggleGenerationLikeApiService, 'toggleGenerationLike').mockResolvedValue({
      generation_id: 'generation-1',
      like_count: 3,
      has_liked: true,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<CommunityPage />);
      });

      const likeButton = container.querySelector('[aria-label="Like community model"]') as HTMLButtonElement;
      expect(likeButton.textContent).toContain('2');

      await act(async () => {
        likeButton.click();
      });

      expect(toggleLike).toHaveBeenCalledWith('generation-1', 'tok');
      expect(navigate).not.toHaveBeenCalled();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('community_model_like_clicked', {
        generation_id: 'generation-1',
        has_liked: true,
        surface: 'community_grid',
        is_authenticated: true,
      });
      expect((container.querySelector('[aria-label="Unlike community model"]') as HTMLButtonElement).textContent).toContain('3');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
