import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/** Keep saved model links working in the landing-page workspace. */
export function GeneratedModelRedirect({ instructions = false }: { instructions?: boolean }) {
  const { search, hash, state } = useLocation();
  const params = new URLSearchParams(search);
  if (!params.get('id')) {
    try {
      const savedId = localStorage.getItem('lastGenerationId');
      if (savedId) params.set('id', savedId);
    } catch { /* Open the landing page when storage is unavailable. */ }
  }
  if (instructions && params.get('id')) {
    params.set('exact', '1');
    params.set('instructions', '1');
  }
  const query = params.toString();
  return <Navigate to={`/${query ? `?${query}` : ''}${hash}`} state={state} replace />;
}
