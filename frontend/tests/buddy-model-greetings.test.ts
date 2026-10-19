import { expect, it } from 'vitest';
import { MODEL_EDIT_INVITATION } from '../src/utils/buddyModelGreetings';

it('uses the same edit and order invitation for every model visit', () => {
  expect(MODEL_EDIT_INVITATION).toBe('Tell me how you’d like to edit it, or click the order button to have it delivered!');
});
