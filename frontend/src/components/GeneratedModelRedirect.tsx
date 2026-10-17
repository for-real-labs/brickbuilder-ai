import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/** Keep saved model links working in the landing-page workspace. */
export function GeneratedModelRedirect() {
  const { search, hash, state } = useLocation();
  const params = new URLSearchParams(search);
  if (!params.get('id')) {
    try {
      const savedId = localStorage.getItem('lastGenerationId');
      if (savedId) params.set('id', savedId);
    } catch { /* Open the landing page when storage is unavailable. */ }
  }
  const query = params.toString();
  return <Navigate to={`/${query ? `?${query}` : ''}${hash}`} state={state} replace />;
}
