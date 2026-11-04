import React from 'react';
import { Navigate } from 'react-router-dom';
import { getGeneratedModelPath } from '../utils/generationRoutes';

export function ImportedStudioOrder({ id }: { id: string }) {
  return <Navigate to={getGeneratedModelPath(id, true)} replace />;
}
