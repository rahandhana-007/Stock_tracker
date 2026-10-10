-- Detail Goods Issued Status / PR: pendamping transaksi SO, BUKAN mutasi stok.
create table if not exists public.pr_details (
  id bigint generated always as identity primary key,
  item_id bigint not null references public.items(id) on delete cascade,
  source_key text not null,
  source_row integer not null,
  year integer not null,
  slip_no text not null default '', line_no integer,
  pr_date text, order_cost_center text, cost_center text,
  account_code text, activity_code text, requestor text,
  description text, specification text, budget_no text, project_no text,
  quantity numeric, uom text, amount numeric, outstanding_amount numeric,
  sap_ref text, sap_date text, sap_qty numeric, sap_amount numeric,
  imported_at timestamptz not null default now(),
  unique(source_key,source_row)
);
create index if not exists pr_details_item_year_idx on public.pr_details(item_id,year);
create index if not exists pr_details_item_ref_idx on public.pr_details(item_id,sap_ref);
alter table public.pr_details enable row level security;
drop policy if exists "authenticated full access" on public.pr_details;
create policy "authenticated full access" on public.pr_details for all to authenticated using (true) with check (true);
grant select,insert,update,delete on public.pr_details to authenticated;
grant usage,select on all sequences in schema public to authenticated;
notify pgrst, 'reload schema';
