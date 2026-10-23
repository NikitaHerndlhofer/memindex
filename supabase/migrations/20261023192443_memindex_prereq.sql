-- memindex prereq (custom): extensions, roles, the memindex schema and the helper functions the
-- drizzle-generated tables depend on. Everything lives in schema memindex, which is NOT in the
-- Data API's exposed schemas.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT e.extname, e.extnamespace::regnamespace::text AS nsp, e.extversion
    FROM pg_extension e
    WHERE e.extname IN ('vector', 'pg_trgm', 'unaccent', 'btree_gin')
  LOOP
    IF r.nsp <> 'extensions' THEN
      RAISE EXCEPTION 'memindex: extension % is installed in schema %, expected "extensions"', r.extname, r.nsp
        USING HINT = format('ALTER EXTENSION %I SET SCHEMA extensions;', r.extname);
    END IF;
    IF r.extname = 'vector' AND string_to_array(r.extversion, '.')::int[] < ARRAY[0, 8] THEN
      RAISE EXCEPTION 'memindex: pgvector >= 0.8 required for iterative index scans (installed %)', r.extversion
        USING HINT = 'ALTER EXTENSION vector UPDATE;';
    END IF;
  END LOOP;
  -- drizzle-kit can't schema-qualify the halfvec column type; it must resolve via search_path.
  IF NOT 'extensions' = ANY (current_schemas(false)) THEN
    RAISE EXCEPTION 'memindex: schema "extensions" must be on the migrating role''s search_path'
      USING HINT = 'ALTER ROLE CURRENT_USER SET search_path = "$user", public, extensions; then reconnect.';
  END IF;
END
$$;

-- NOLOGIN groups. Machine logins are created later by an operator command (IN ROLE …).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memindex_writer') THEN
    CREATE ROLE memindex_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memindex_reader') THEN
    CREATE ROLE memindex_reader NOLOGIN;
  END IF;
END
$$;

-- Applies to sessions that log in as the reader role itself; the operator command repeats it on
-- reader logins. The store's run() path is READ ONLY regardless.
ALTER ROLE memindex_reader SET default_transaction_read_only = on;
-- run() drops to memindex_reader with SET LOCAL ROLE, so writers and the owner must be members.
GRANT memindex_reader TO memindex_writer;
-- A literal `GRANT … TO CURRENT_USER` segfaults the backend under Supabase's supautils (17.6).
DO $$
BEGIN
  EXECUTE format('GRANT memindex_reader TO %I', current_user);
END
$$;

CREATE SCHEMA IF NOT EXISTS memindex;
REVOKE ALL ON SCHEMA memindex FROM PUBLIC;
GRANT USAGE ON SCHEMA memindex TO memindex_writer, memindex_reader;
GRANT USAGE ON SCHEMA extensions TO memindex_writer, memindex_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA memindex REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- unaccent() is STABLE (it reads a dictionary); generated columns and indexes need IMMUTABLE.
-- Pinning the dictionary by schema-qualified name makes the wrapper safe to mark IMMUTABLE.
CREATE OR REPLACE FUNCTION memindex.immutable_unaccent(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN extensions.unaccent('extensions.unaccent'::regdictionary, t);

CREATE OR REPLACE FUNCTION memindex.iso(ts timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

CREATE OR REPLACE FUNCTION memindex.excerpt(body text, q text, width int DEFAULT 240) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN q IS NULL OR strpos(lower(body), lower(q)) = 0 THEN left(body, width)
    ELSE substr(body, greatest(1, strpos(lower(body), lower(q)) - width / 3), width)
  END;

CREATE OR REPLACE FUNCTION memindex.forbid_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memindex: % on %.% is not allowed (%)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0]
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE OR REPLACE FUNCTION memindex.item_identity_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_key <> OLD.item_key OR NEW.source <> OLD.source THEN
    RAISE EXCEPTION 'memindex: item identity is immutable (%)', OLD.item_key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
