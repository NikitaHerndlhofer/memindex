-- memindex bounded vec gc (custom): vec_gc deletes every orphan in one statement, and even with none
-- left it anti-joins every vector of the space (0.8 s on a 274k-vector archive). One step instead walks
-- the next `lim` vectors after `after` in primary-key order and deletes those no embeddable chunk
-- references at statement time; the caller resumes from `next_after` until it is NULL.

CREATE OR REPLACE FUNCTION memindex.vec_gc_step(space text, after text, lim int)
RETURNS TABLE (deleted int, next_after text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = memindex, extensions, pg_temp
AS $$
  WITH w AS (
    SELECT v.content_hash FROM memindex.chunk_vector v
    WHERE v.space = vec_gc_step.space AND v.content_hash > vec_gc_step.after
    ORDER BY v.content_hash
    LIMIT vec_gc_step.lim
  ), gone AS (
    DELETE FROM memindex.chunk_vector v USING w
    WHERE v.space = vec_gc_step.space AND v.content_hash = w.content_hash
      AND NOT EXISTS (SELECT 1 FROM memindex.chunk c WHERE c.content_hash = w.content_hash AND c.embed)
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM gone),
         CASE WHEN (SELECT count(*) FROM w) = vec_gc_step.lim THEN (SELECT max(w.content_hash) FROM w) END
$$;

REVOKE ALL ON FUNCTION memindex.vec_gc_step(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memindex.vec_gc_step(text, text, int) TO memindex_writer;
