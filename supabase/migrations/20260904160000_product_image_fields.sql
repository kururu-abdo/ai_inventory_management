-- Storage upload is deliberately not enabled in the trial. This nullable URL
-- field is ready for a future private product-images bucket and signed URLs.
alter table public.products add column if not exists image_url text;
