import type { PlanKey } from '../services/billingApi';

export const PLAN_GENERATIONS: Record<PlanKey, number> = {
  free: 5, builder: 15, creator: 100, master: 50,
};

export const PLAN_DISCOUNTS: Record<PlanKey, number> = {
  free: 0, builder: 10, creator: 20, master: 20,
};
