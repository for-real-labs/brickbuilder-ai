-- Exercise the production mode trigger without creating a generation or charging an account.
BEGIN;
CREATE TEMP TABLE pip_test_generation(endpoint text, mode text, generation_id uuid);
CREATE TRIGGER assign_mode BEFORE INSERT ON pip_test_generation
FOR EACH ROW EXECUTE FUNCTION public.assign_generation_mode();
INSERT INTO pip_test_generation(endpoint) VALUES ('pipModelCall');
DO $$ BEGIN
  ASSERT (SELECT mode = 'all_parts' FROM pip_test_generation);
  ASSERT public.generation_can_send_ready_email('pipModelCall');
  ASSERT public.guest_generation_cost('pipModelCall') = public.guest_generation_cost('novaToBricks');
END $$;
ROLLBACK;
