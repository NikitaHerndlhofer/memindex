-- memindex vector bulk load (custom): legacy imports seed hundreds of thousands of vectors, and
-- maintaining the space's HNSW index row by row is what limits that. The store drops the index
-- (this function), inserts, then rebuilds it once through ensure_vector_space, which recreates
-- any vector index missing from derived_object. Searches stay correct while it is absent.

CREATE OR REPLACE FUNCTION memindex.drop_vector_index(space text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
DECLARE
  idx text;
BEGIN
  SELECT vs.index_name INTO idx FROM memindex.vector_space vs WHERE vs.space_id = space;
  IF idx IS NULL THEN
    RAISE EXCEPTION 'memindex: unknown vector space %', space USING ERRCODE = 'undefined_object';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memindex.derived:' || idx, 0));
  DELETE FROM memindex.derived_object d WHERE d.name = idx;
  EXECUTE format('DROP INDEX IF EXISTS memindex.%I', idx);
END
$$;

REVOKE ALL ON FUNCTION memindex.drop_vector_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.drop_vector_index(text) TO memindex_writer;
