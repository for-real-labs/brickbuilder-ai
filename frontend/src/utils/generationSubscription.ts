export const GENERATION_SUBSCRIPTION_EVENT = 'brickbuilder:generation-subscription-required';
export const GENERATION_SUBSCRIPTION_SOURCE = 'generation_subscription';
export const GENERATION_SUBSCRIPTION_CODE = 'BB_SUBSCRIPTION_REQUIRED';

export function openGenerationSubscription() {
  window.dispatchEvent(new Event(GENERATION_SUBSCRIPTION_EVENT));
}
