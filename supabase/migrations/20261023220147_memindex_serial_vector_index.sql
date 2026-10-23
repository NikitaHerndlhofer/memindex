-- memindex serial vector index builds (custom): a parallel HNSW build puts all of
-- maintenance_work_mem in one shared-memory segment, which fails in Docker's default 64 MB
-- /dev/shm (the local Supabase stack). ensure_vector_space builds every per-space index (bulkPut's
-- rebuild and the repair on open), so it builds serially, in backend memory.
ALTER FUNCTION memindex.ensure_vector_space(text, text, int) SET max_parallel_maintenance_workers = 0;
