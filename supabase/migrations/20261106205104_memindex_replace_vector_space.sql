-- memindex replace vector space (custom): switching embedding models replaces the old model's vectors instead of
-- keeping them. The first write-open with a model whose space is not registered drops every other space in one
-- transaction: its vectors, its vector index, its ledger entry and its registry row. Opening again, or with a
-- model that is already registered, changes nothing. A producer still on an older release cannot undo a swap:
-- the schema gate refuses writes from a binary older than the schema, so upgrade every machine together.
--
-- Search is unaffected: it only ever read the active space. The new space is searched as it fills, so semantic
-- search sees only what the new model has embedded so far; keyword and fuzzy search never depended on vectors.
-- Rows are deleted before the index is dropped, so readers wait only for the index drop itself.
--
-- Measured on a copy of the eval snapshot holding 333k vectors of one space: registering the second space took
-- 58 s, deleted every old vector and freed the 868 MB vector index at once (the deleted rows' pages are reused
-- by the new vectors). Re-registering the same space again changed nothing.

CREATE OR REPLACE FUNCTION memindex.ensure_vector_space(space text, model text, dim int) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
SET max_parallel_maintenance_workers = 0
AS $$
DECLARE
  idx text := left('chunk_vector_hnsw_' || regexp_replace(lower(space), '[^a-z0-9]+', '_', 'g'), 50)
              || '_' || left(md5(space), 8);
  def text := format('CREATE INDEX %I ON memindex.chunk_vector USING hnsw ((embedding::extensions.halfvec(%s)) extensions.halfvec_cosine_ops) WHERE space = %L',
                     idx, dim, space);
  sum text := encode(sha256(convert_to(def, 'UTF8')), 'hex');
  have text;
  have_dim int;
  gone record;
BEGIN
  IF dim IS NULL OR dim < 1 OR dim > 4000 THEN
    RAISE EXCEPTION 'memindex: vector dim % out of range 1..4000 (halfvec HNSW limit)', dim;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memindex.derived:' || idx, 0));
  SELECT vs.dim INTO have_dim FROM memindex.vector_space vs WHERE vs.space_id = space;
  IF have_dim IS NOT NULL AND have_dim <> dim THEN
    RAISE EXCEPTION 'memindex: vector space % already exists with dim %', space, have_dim;
  END IF;
  INSERT INTO memindex.vector_space (space_id, model, dim, index_name) VALUES (space, model, dim, idx)
    ON CONFLICT (space_id) DO NOTHING;
  IF FOUND THEN
    -- A new space replaces every other one. Rows go first, so readers are not blocked while they are
    -- deleted; the index drop, the only table lock, comes last.
    FOR gone IN SELECT vs.space_id, vs.index_name FROM memindex.vector_space vs WHERE vs.space_id <> space LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('memindex.derived:' || gone.index_name, 0));
      DELETE FROM memindex.chunk_vector v WHERE v.space = gone.space_id;
      DELETE FROM memindex.derived_object d WHERE d.name = gone.index_name;
      EXECUTE format('DROP INDEX IF EXISTS memindex.%I', gone.index_name);
      DELETE FROM memindex.vector_space vs WHERE vs.space_id = gone.space_id;
    END LOOP;
  END IF;
  SELECT d.checksum INTO have FROM memindex.derived_object d WHERE d.name = idx;
  IF have IS DISTINCT FROM sum OR to_regclass('memindex.' || quote_ident(idx)) IS NULL THEN
    EXECUTE format('DROP INDEX IF EXISTS memindex.%I', idx);
    EXECUTE def;
    INSERT INTO memindex.derived_object (name, kind, checksum) VALUES (idx, 'vector_index', sum)
      ON CONFLICT (name) DO UPDATE SET checksum = excluded.checksum, created_at = now();
  END IF;
END
$$;
