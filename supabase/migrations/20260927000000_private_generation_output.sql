-- Live thinking is private even for models later published to the community.
INSERT INTO storage.buckets (id, name, public)
VALUES ('generation-output', 'generation-output', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Defense against broad existing storage policies. Only the backend service
-- role (which bypasses RLS) may read/write this bucket.
CREATE POLICY "private_generation_output_backend_only"
ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (bucket_id <> 'generation-output')
WITH CHECK (bucket_id <> 'generation-output');
