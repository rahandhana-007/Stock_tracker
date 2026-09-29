#!/usr/bin/env bash
# Menyiapkan lingkungan uji lokal (Debian/Ubuntu): PostgreSQL + PostgREST + Playwright + node_modules,
# lalu membuat database "fc" dari schema.sql + seed.sql (+ seed_transactions.sql bila ada).
#   bash tests/bootstrap.sh            → siapkan semuanya
#   bash tests/bootstrap.sh db         → hanya reset database fc
set -e
cd "$(dirname "$0")/.."
if [ "${1:-all}" = "all" ]; then
  ( sudo apt-get update -qq && sudo apt-get install -y -qq postgresql postgresql-contrib >/tmp/apt.log 2>&1 && echo "postgres installed" ) &
  ( [ -x /tmp/postgrest ] || { curl -sSL -o /tmp/pgrst.tar.xz https://github.com/PostgREST/postgrest/releases/download/v16.4/postgrest-v16.4-linux-static-x86-64.tar.xz && tar -xJf /tmp/pgrst.tar.xz -C /tmp; }; echo "postgrest ready" ) &
  ( pip install -q playwright >/dev/null 2>&1; python3 -m playwright install chromium >/dev/null 2>&1; echo "playwright downloaded" ) &
  ( [ -d /tmp/vend/node_modules ] || { mkdir -p /tmp/vend && cd /tmp/vend && npm i --silent @supabase/supabase-js@2 xlsx@0.18.5 exceljs@4.4.0 >/dev/null 2>&1; }; echo "node_modules ready" ) &
  wait
  sudo python3 -m playwright install-deps chromium >/dev/null 2>&1 && echo "playwright deps ready"   # setelah apt selesai (hindari lock)
  sudo pg_ctlcluster 17 main start 2>/dev/null || sudo pg_ctlcluster 16 main start 2>/dev/null || true
  sleep 2
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "do \$\$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login password 'secret'; end if;
  end \$\$;" -c "grant anon, authenticated to authenticator;"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "drop database if exists fc with (force);" -c "create database fc;" 2>&1 | grep -v NOTICE || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d fc -f supabase/schema.sql 2>&1 | grep -v NOTICE || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d fc -f supabase/seed.sql
[ -f supabase/seed_transactions.sql ] && sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d fc -f supabase/seed_transactions.sql
sudo -u postgres psql -d fc -Atc "select 'db fc: '||(select count(*) from items)||' items, '||(select count(*) from monthly)||' monthly, '||(select count(*) from transactions)||' transactions'"
echo "BOOTSTRAP_DONE"
