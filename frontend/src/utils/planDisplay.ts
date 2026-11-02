import type { PlanKey } from '../services/billingApi';

export const PLAN_GENERATIONS: Record<PlanKey, number> = {
  free: 5, builder: 15, creator: 100, master: 50,
};
