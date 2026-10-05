export const getGeneratedModelPath = (generationId: string, exact = false): string =>
  `/generated-model?id=${encodeURIComponent(generationId)}${exact ? '&exact=1' : ''}`;

export const getOrderReturnModelPath = (
  orderGenerationId: string | undefined,
  lastGenerationId: string | null,
): string => {
  const generationId = orderGenerationId || lastGenerationId;
  return generationId ? getGeneratedModelPath(generationId) : '/generated-model';
};
