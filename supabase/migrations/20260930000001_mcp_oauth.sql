-- Apply before enabling MCP. Register clients and enable the hook separately;
-- installing this migration does not change existing token issuance.
create table if not exists public.mcp_oauth_clients (
    client_id text primary key,
    resource_url text not null check (resource_url ~ '^https://[^/?#]+/mcp$')
);
alter table public.mcp_oauth_clients enable row level security;
revoke all on public.mcp_oauth_clients from public, anon, authenticated;
grant all on public.mcp_oauth_clients to service_role;
grant select on public.mcp_oauth_clients to supabase_auth_admin;
create policy mcp_oauth_hook_read on public.mcp_oauth_clients
    for select to supabase_auth_admin using (true);

create or replace function public.mcp_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
    claims jsonb := event->'claims';
    resource text;
begin
    select resource_url into resource from public.mcp_oauth_clients
        where client_id = claims->>'client_id';
    if resource is not null then
        -- Bind to this MCP resource instead of accepting generic web tokens.
        claims := jsonb_set(claims, '{aud}', to_jsonb(resource));
        -- Supabase supports OIDC scopes rather than arbitrary application
        -- scopes. The consent UI explains the build/read permissions attached
        -- to these approved connectors. MCP requests the email scope.
        claims := jsonb_set(claims, '{scope}', '"email"'::jsonb);
    end if;
    return jsonb_build_object('claims', claims);
end;
$$;
revoke all on function public.mcp_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.mcp_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
