import React, { useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, Wand2, X } from 'lucide-react';
import { PetChatMessage, PetPromptGreeting, PetTypingIndicator } from './PetCompanion';
import { usePet } from '../contexts/PetContext';
import { useBuildBuddyChat } from '../hooks/useBuildBuddyChat';

import posthog from 'posthog-js';
import { IMAGE_UPLOAD_ACCEPT, prepareImageUpload } from '../utils/prepareImageUpload';

export interface EditReferenceImage {
  imageBase64: string;
  imageMediaType: string;
}

interface Props {
  prompt: string;
  examplePrompt?: string | null;
  modelName?: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: (image?: EditReferenceImage) => Promise<boolean | void> | void;
  loading: boolean;
  disabled: boolean;
  error: string | null;
  manualEditControl?: React.ReactNode;
  authToken?: string;
  ownerId?: string;
}

export function VoxelPromptEditor({ examplePrompt, modelName, prompt, onPromptChange, onSubmit, loading, disabled, error, manualEditControl, authToken, ownerId }: Props) {
  const { pet, activity } = usePet();
  const [focused, setFocused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<EditReferenceImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const busy = loading || disabled || preparing;
  const selectImage = async (file: File) => {
    setPreparing(true);
    setImageError(null);
    try {
      const prepared = await prepareImageUpload(file);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read this image.'));
        reader.onerror = () => reject(new Error('Unable to read this image.'));
        reader.readAsDataURL(prepared);
      });
      setImage({ imageBase64: dataUrl.split(',')[1], imageMediaType: prepared.type });
      posthog.capture('generated_model_ai_edit_image_uploaded', { format: prepared.type });
    } catch (cause) {
      setImageError(cause instanceof Error ? cause.message : 'Unable to read this image.');
      posthog.capture('generated_model_ai_edit_image_rejected');
    } finally { setPreparing(false); }
  };
  const chat = useBuildBuddyChat(pet.id, authToken, ownerId);
  return (
    <form className="model-refine-card"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!prompt.trim() || busy) return;
        const turn = chat.startTurn(prompt.trim(), null);
        chat.requestReply(turn, prompt.trim());
        if (await onSubmit(image || undefined)) setImage(null);
      }}>
      <PetPromptGreeting mode="edit" state={loading ? 'building' : focused ? 'listening' : activity} />
      {chat.turns.length > 0 && <div className="pet-dialogue" role="log" aria-label="Model edit conversation" aria-live="polite">
        <div className="pet-dialogue-content">{chat.turns.map(turn => <div key={turn.id} className="pet-dialogue-turn">
          <PetChatMessage user><p>{turn.text}</p></PetChatMessage>
          <PetChatMessage state={turn.reply ? 'idle' : 'listening'}>{turn.reply ? <p>{turn.reply}</p> : <PetTypingIndicator />}</PetChatMessage>
        </div>)}</div>
      </div>}
      <label htmlFor="voxel-edit-prompt" className="block text-lg font-semibold text-slate-900">Refine your model</label>
      <p id="voxel-edit-help" className="mt-1 text-sm text-slate-500">Tell {pet.name} what you’d like to change, and optionally add a reference image.</p>
      <input ref={picker} type="file" accept={IMAGE_UPLOAD_ACCEPT} aria-label="Choose edit reference image"
        className="hidden" disabled={busy} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void selectImage(file);
        }} />
      {image && <div className="relative mt-3 w-fit max-w-full">
        <img src={`data:${image.imageMediaType};base64,${image.imageBase64}`} alt="Edit reference"
          className="max-h-32 max-w-full rounded-xl object-contain" />
        <button type="button" aria-label="Remove edit image" disabled={busy}
          className="absolute right-1 top-1 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:text-red-500 disabled:opacity-50"
          onClick={() => { setImage(null); setImageError(null); posthog.capture('generated_model_ai_edit_image_removed'); }}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>}
      <div className="relative mt-3">
      <button type="button" aria-label="Upload edit image" title="Upload image" disabled={busy}
        onClick={() => { posthog.capture('generated_model_ai_edit_image_picker_opened', { upload_position: 'input_left_icon' }); picker.current?.click(); }}
        className="absolute left-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50">
        <ImageIcon aria-hidden="true" className="h-5 w-5" />
      </button>
      <textarea id="voxel-edit-prompt" aria-describedby="voxel-edit-help" maxLength={2000} rows={3}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        value={prompt} onChange={(event) => onPromptChange(event.target.value)} disabled={busy}
        placeholder={`e.g. ${examplePrompt?.trim() || (modelName ? `Change the colors of the ${modelName} and add more detail` : 'Make the roof red and add a chimney…')}`}
        className="block w-full resize-y rounded-xl border border-slate-200 bg-slate-50 pl-14 pr-3 py-3 text-base text-slate-900 focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100 disabled:opacity-60" />
      </div>
      {preparing && <p role="status" className="mt-2 text-sm text-slate-500">Preparing your image…</p>}
      {imageError && <p role="alert" className="mt-2 text-sm text-red-600">{imageError}</p>}
      <div className="mt-3 flex items-center gap-2 sm:gap-3">
        <button type="submit" disabled={busy || !prompt.trim()}
          className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
          {loading ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <Wand2 size={16} className="shrink-0" />}
          {loading ? 'Editing model…' : 'Apply Edit'}
        </button>
        {manualEditControl && <div className="model-manual-edit shrink-0">{manualEditControl}</div>}
      </div>
      {loading && <p role="status" className="mt-2 text-sm text-slate-500">Updating your model. This can take a few minutes.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </form>
  );
}
