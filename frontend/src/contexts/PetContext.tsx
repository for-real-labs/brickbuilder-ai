import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { PETS, PET_MOTION_KEY, PET_STORAGE_KEY, isPetId, type PetId, type PetState } from '../pets';

function readPreference(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function savePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* The companion still works when browser storage is unavailable. */ }
}

const PetContext = createContext({
  pet: PETS[0] as typeof PETS[number],
  motion: true,
  activity: 'idle' as PetState,
  pickerOpen: false,
  selectPet: (_id: PetId) => {},
  setMotion: (_enabled: boolean) => {},
  setActivity: (_state: PetState) => {},
  openPicker: (_source: string, _returnTo?: HTMLElement | null) => {},
  closePicker: () => {},
});

export function PetProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState<PetId>(() => {
    const saved = readPreference(PET_STORAGE_KEY);
    return isPetId(saved) ? saved : 'pip';
  });
  const [motion, updateMotion] = useState(() => readPreference(PET_MOTION_KEY) !== 'paused');
  const [activity, setActivity] = useState<PetState>('idle');
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerSource = useRef('companion');
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === PET_STORAGE_KEY || event.key === null) {
        const saved = readPreference(PET_STORAGE_KEY);
        setId(isPetId(saved) ? saved : 'pip');
      }
      if (event.key === PET_MOTION_KEY || event.key === null) updateMotion(readPreference(PET_MOTION_KEY) !== 'paused');
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const openPicker = useCallback((source: string, returnTo?: HTMLElement | null) => {
    pickerSource.current = source;
    returnFocus.current = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setPickerOpen(true);
    posthog.capture('pet_picker_opened', { source });
  }, []);
  const closePicker = useCallback(() => {
    setPickerOpen(false);
    posthog.capture('pet_picker_closed', { source: pickerSource.current });
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  }, []);
  const selectPet = useCallback((next: PetId) => {
    if (!isPetId(next)) return;
    if (next !== id) {
      setId(next);
      savePreference(PET_STORAGE_KEY, next);
      posthog.capture('pet_selected', { pet_id: next, previous_pet_id: id, source: pickerSource.current });
    }
    closePicker();
  }, [id, closePicker]);
  const setMotion = useCallback((enabled: boolean) => {
    updateMotion(enabled);
    savePreference(PET_MOTION_KEY, enabled ? 'playing' : 'paused');
    posthog.capture('pet_motion_changed', { enabled });
  }, []);
  const value = useMemo(() => ({ pet: PETS.find(pet => pet.id === id)!, motion, activity,
    pickerOpen, selectPet, setMotion, setActivity, openPicker, closePicker,
  }), [id, motion, activity, pickerOpen, selectPet, setMotion, openPicker, closePicker]);

  return <PetContext.Provider value={value}>{children}</PetContext.Provider>;
}

export const usePet = () => useContext(PetContext);

/** A page owns its activity until it unmounts. Only a successful build celebrates. */
export function usePetActivity(busy: boolean, completed = false, failed = false) {
  const { setActivity } = usePet();
  const wasBusy = useRef(false);
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    if (wasBusy.current && !busy && completed && !failed) setCelebrating(true);
    if (busy || failed) setCelebrating(false);
    wasBusy.current = busy;
  }, [busy, completed, failed]);
  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(() => setCelebrating(false), 5000);
    return () => window.clearTimeout(timer);
  }, [celebrating]);
  const state: PetState = busy ? 'building' : celebrating ? 'celebrating' : 'idle';
  useEffect(() => { setActivity(state); }, [state, setActivity]);
  useEffect(() => () => setActivity('idle'), [setActivity]);
  return state;
}
