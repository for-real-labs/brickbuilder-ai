import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Users } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { ClaimGenerationApiService } from '../services/claimGenerationApi';
import { ToggleIsCommunityApiService } from '../services/toggleIsCommunityApi';
import { UpdateGenerationNameApiService } from '../services/updateGenerationNameApi';
import { UpdateImagePreviewApiService } from '../services/updateImagePreviewApi';
import { getAnonymousGenerationIds } from '../utils/anonGenerations';
import LoginModal from './LoginModal';

const pendingKey = 'brickbuilder.community-post';

export function LandingCommunityAction({ id, busy, preview, onNameSaved }: {
  id: string; busy: boolean; preview: () => string | undefined; onNameSaved?: (id: string, name: string) => void;
}) {
  const { user, session, loading, userProfile } = useAuth();
  const [owner, setOwner] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [hasPreview, setHasPreview] = useState(false);
  const [login, setLogin] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const pending = useRef(false);
  const token = session?.access_token;
  const userId = user?.id;
  const canPost = Boolean(token && userId && owner === userId);

  useEffect(() => {
    let active = true;
    if (!userId || !token) { setOwner(null); setNaming(false); return; }
    const load = async () => {
      let resume = pending.current;
      try { resume ||= sessionStorage.getItem(pendingKey) === id; } catch { /* Same-page login still works. */ }
      if (resume && getAnonymousGenerationIds().includes(id)) {
        // The server checks the guest session and refuses to claim another user's model.
        await ClaimGenerationApiService.claimGeneration(id, token).catch(() => undefined);
      }
      const { data, error: readError } = await supabase.from('generations')
        .select('user_id,is_community,preview_image_url').eq('id', id).maybeSingle();
      if (!active) return;
      if (resume) {
        pending.current = false;
        setLogin(false);
        try { sessionStorage.removeItem(pendingKey); } catch { /* Storage is optional. */ }
      }
      if (readError || data?.user_id !== userId) {
        setOwner(null);
        if (resume) setError('Only the owner can post this model to the community.');
        return;
      }
      setOwner(userId);
      setPublished(Boolean(data.is_community));
      setHasPreview(Boolean(data.preview_image_url));
      if (resume && !data.is_community) setNaming(true);
    };
    void load().catch(() => { if (active) setError('Could not check who owns this model.'); });
    return () => { active = false; };
  }, [id, userId, token]);

  useEffect(() => {
    const element = dialog.current;
    if (!naming || !element) return;
    element.showModal();
    return () => element.close();
  }, [naming]);

  const toggle = async (post: boolean) => {
    if (!canPost || !token || busy || saving || post === published) return;
    const trimmed = name.trim();
    if (post && (!trimmed || trimmed.length > 200)) { setError('Enter a model name of up to 200 characters.'); return; }
    setSaving(true);
    setError('');
    try {
      if (post) {
        const image = preview();
        if (!hasPreview && image) {
          await UpdateImagePreviewApiService.updateImagePreview(id, image, token);
          setHasPreview(true);
        }
        await UpdateGenerationNameApiService.updateGenerationName(id, trimmed, token);
        onNameSaved?.(id, trimmed);
      }
      const response = await ToggleIsCommunityApiService.toggleIsCommunity(id, token);
      setPublished(response.is_community ?? response.isCommunity ?? post);
      setNaming(false);
      posthog.capture(post ? 'landing_community_model_posted' : 'landing_community_model_removed', { generation_id: id });
    } catch {
      setError(post ? 'Could not post this model. Please try again.' : 'Could not remove this model. Please try again.');
    } finally { setSaving(false); }
  };

  const label = published ? 'Remove from Community' : 'Post to Community';
  return <>
    {!loading && (!userId || canPost) && <button type="button" className="landing-action-button" disabled={busy || saving}
      onClick={() => {
        setError('');
        posthog.capture('landing_community_action_clicked', { generation_id: id, action: published ? 'remove' : 'post' });
        if (!userId) { pending.current = true; try { sessionStorage.setItem(pendingKey, id); } catch { /* Storage is optional. */ } setLogin(true); }
        else if (published) void toggle(false);
        else setNaming(true);
      }}><Users size={16} aria-hidden="true" />{label}</button>}
    {error && !naming && <span role="alert" className="text-sm text-red-700">{error}</span>}
    {login && createPortal(<LoginModal open redirectTo={`/?id=${encodeURIComponent(id)}`}
      onClose={() => { setLogin(false); pending.current = false; try { sessionStorage.removeItem(pendingKey); } catch { /* Storage is optional. */ } }} onSuccess={() => setLogin(false)} />, document.body)}
    {naming && <dialog ref={dialog} aria-labelledby={title} className="landing-community-dialog m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl bg-white p-6 shadow-xl backdrop:bg-slate-900/40"
      onCancel={event => { event.preventDefault(); if (!saving) { setNaming(false); setError(''); } }}>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void toggle(true); }}>
        <h2 id={title} className="text-lg font-semibold">Post to Community</h2>
        <p className="text-sm text-slate-600">Your model will be public. Posting as {userProfile?.username?.trim() || user?.email?.split('@')[0] || 'builder'}.</p>
        <label className="block text-sm font-medium">Model name
          <input autoFocus required maxLength={200} value={name} disabled={saving} onChange={event => setName(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="landing-action-button" disabled={saving} onClick={() => { setNaming(false); setError(''); }}>Cancel</button>
          <button type="submit" className="landing-action-button" disabled={busy || saving || !canPost || !name.trim()}>{saving ? 'Posting…' : 'Post to Community'}</button>
        </div>
      </form>
    </dialog>}
  </>;
}
