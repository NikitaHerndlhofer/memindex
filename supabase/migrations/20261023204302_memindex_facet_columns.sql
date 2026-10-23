-- memindex facet columns (custom): plugins key facets by their meta keys, which are camelCase
-- (superwhisper `appName`, `durationMs`). The `<source>_items` view exposes each one as a
-- snake_case column (`app_name`) that reads `meta ->> 'appName'`. Keys must still be plain
-- identifiers; two keys that map to the same column are refused.

-- `appName` → `app_name`, `HTTPStatus` → `http_status`, `duration_ms` unchanged.
-- Mirrored by facetColumn() in packages/store/src/facets.ts.
CREATE OR REPLACE FUNCTION memindex.facet_column(key text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN lower(regexp_replace(regexp_replace(key, '([A-Z]+)([A-Z][a-z])', '\1_\2', 'g'),
                              '([a-z0-9])([A-Z])', '\1_\2', 'g'));

CREATE OR REPLACE FUNCTION memindex.ensure_facet_view(source text, facets jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
DECLARE
  vname text;
  cols text := '';
  col text;
  colname text;
  seen text[] := '{}';
  r record;
  def text;
  sum text;
  have text;
BEGIN
  IF source !~ '^[a-z][a-z0-9-]*$' THEN
    RAISE EXCEPTION 'memindex: invalid source id %', source;
  END IF;
  vname := replace(source, '-', '_') || '_items';
  FOR r IN SELECT key, value #>> '{}' AS typ FROM jsonb_each(coalesce(facets, '{}'::jsonb)) ORDER BY key LOOP
    IF r.key !~ '^[A-Za-z_][A-Za-z0-9_]*$' OR octet_length(r.key) > 63 THEN
      RAISE EXCEPTION 'memindex: invalid facet name % for source % (letters, digits and _, at most 63)', r.key, source;
    END IF;
    colname := memindex.facet_column(r.key);
    IF colname = ANY (seen) THEN
      RAISE EXCEPTION 'memindex: facets of source % map to the same column % (%)', source, colname, r.key;
    END IF;
    seen := seen || colname;
    IF EXISTS (SELECT 1 FROM information_schema.columns c
               WHERE c.table_schema = 'memindex' AND c.table_name = 'items' AND c.column_name = colname) THEN
      RAISE EXCEPTION 'memindex: facet % of source % collides with the items column %', r.key, source, colname;
    END IF;
    col := CASE r.typ
      WHEN 'text' THEN format('(meta ->> %L)', r.key)
      WHEN 'time' THEN format('(meta ->> %L)', r.key)
      WHEN 'int' THEN format('CASE WHEN jsonb_typeof(meta -> %L) = ''number'' THEN trunc((meta ->> %L)::numeric)::int8 END', r.key, r.key)
      WHEN 'real' THEN format('CASE WHEN jsonb_typeof(meta -> %L) = ''number'' THEN (meta ->> %L)::float8 END', r.key, r.key)
      WHEN 'bool' THEN format('CASE WHEN jsonb_typeof(meta -> %L) = ''boolean'' THEN CASE WHEN (meta ->> %L)::boolean THEN 1 ELSE 0 END END', r.key, r.key)
    END;
    IF col IS NULL THEN
      RAISE EXCEPTION 'memindex: facet % of source % has unknown type %', r.key, source, r.typ;
    END IF;
    cols := cols || ', ' || col || format(' AS %I', colname);
  END LOOP;
  def := format('CREATE VIEW memindex.%I AS SELECT items.*%s FROM memindex.items WHERE items.source = %L',
                vname, cols, source);
  sum := encode(sha256(convert_to(def, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('memindex.derived:' || vname, 0));
  SELECT d.checksum INTO have FROM memindex.derived_object d WHERE d.name = vname;
  IF have IS DISTINCT FROM sum OR to_regclass('memindex.' || quote_ident(vname)) IS NULL THEN
    EXECUTE format('DROP VIEW IF EXISTS memindex.%I', vname);
    EXECUTE def;
    EXECUTE format('GRANT SELECT ON memindex.%I TO memindex_reader, memindex_writer', vname);
    INSERT INTO memindex.derived_object (name, kind, checksum) VALUES (vname, 'facet_view', sum)
      ON CONFLICT (name) DO UPDATE SET checksum = excluded.checksum, created_at = now();
  END IF;
  RETURN vname;
END
$$;

REVOKE ALL ON FUNCTION memindex.facet_column(text), memindex.ensure_facet_view(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.facet_column(text) TO memindex_reader, memindex_writer;
GRANT EXECUTE ON FUNCTION memindex.ensure_facet_view(text, jsonb) TO memindex_writer;
