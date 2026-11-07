-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It creates the MOCK Home Affairs registry used by the Edge Function.

create table if not exists public.mock_registry (
  id_number       text primary key check (id_number ~ '^[0-9]{13}$'),
  full_name       text        not null,
  province        text        not null,
  token_issued    boolean     not null default false,  -- one ballot token per ID, ever
  token_issued_at timestamptz
);

-- Row Level Security ON with NO policies = the public (anon) key can read nothing.
-- Only the Edge Function (service role key) can touch this table.
alter table public.mock_registry enable row level security;

-- Five test citizens. All IDs pass the official 13-digit Luhn checksum.
insert into public.mock_registry (id_number, full_name, province) values
  ('8001015009087', 'Thabo Mokoena',   'Gauteng'),
  ('9202204720083', 'Lindiwe Dlamini', 'KwaZulu-Natal'),
  ('8512125800082', 'Pieter van Wyk',  'Western Cape'),
  ('0003155123080', 'Naledi Khumalo',  'Eastern Cape'),
  ('1001015009084', 'Test Underage',   'Limpopo')   -- born 2010: must be rejected as under 18
on conflict (id_number) do nothing;

-- To re-run the demo for everyone, execute:
-- update public.mock_registry set token_issued = false, token_issued_at = null;
