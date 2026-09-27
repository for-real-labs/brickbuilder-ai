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

  it('defaults to sorting by likes and requests the top sort from the API', async () => {
    const getCommunityGenerations = vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({
      generations: [],
      total_count: 0,
      has_more: false,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<CommunityPage />);
      });

      expect(getCommunityGenerations).toHaveBeenCalledWith('tok', 50, 0, undefined, 'top');
      expect((container.querySelector('[aria-label="Sort community models"]') as HTMLSelectElement).value).toBe('likes');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('filters by name or creator and refetches with the selected date sort', async () => {
    const getCommunityGenerations = vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({
      generations: [
        {
          id: 'generation-1', user_id: 'owner-1', user_type: 'authenticated', prompt: 'castle',
          name: 'Castle', detail_level: 10, endpoint: 'llm', created_at: '2026-09-26T00:00:00Z',
          status: 'completed', username: 'alice', like_count: 2,
        },
        {
          id: 'generation-2', user_id: 'owner-2', user_type: 'authenticated', prompt: 'dragon',
          name: 'Dragon', detail_level: 10, endpoint: 'llm', created_at: '2026-09-25T00:00:00Z',
          status: 'completed', username: 'bob', like_count: 5,
        },
      ],
      total_count: 2,
      has_more: false,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<CommunityPage />);
      });

      const search = container.querySelector('input[placeholder="Search by name or creator"]') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'alice');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.textContent).toContain('Castle');
      expect(container.textContent).not.toContain('Dragon');

      const sortSelect = container.querySelector('[aria-label="Sort community models"]') as HTMLSelectElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sortSelect, 'date_asc');
        sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(getCommunityGenerations).toHaveBeenLastCalledWith('tok', 50, 0, undefined, 'recent');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
