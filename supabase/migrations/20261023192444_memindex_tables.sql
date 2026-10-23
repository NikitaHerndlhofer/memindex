CREATE TABLE "memindex"."capture" (
	"item_key" text NOT NULL,
	"rev_hash" text NOT NULL,
	"producer_id" text NOT NULL,
	"format" text NOT NULL,
	"parser_version" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" json NOT NULL,
	CONSTRAINT "capture_item_key_rev_hash_pk" PRIMARY KEY("item_key","rev_hash")
);
--> statement-breakpoint
ALTER TABLE "memindex"."capture" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."chunk" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"item_key" text NOT NULL,
	"turn_key" text NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ord" integer NOT NULL,
	"part_idx" integer NOT NULL,
	"sub" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"text" text NOT NULL,
	"embed_text" text,
	"content_hash" text NOT NULL,
	"chunk_hash" text NOT NULL,
	"embed" boolean NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, memindex.immutable_unaccent(text)), 'A') || to_tsvector('simple'::regconfig, memindex.immutable_unaccent(text))) STORED NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memindex"."chunk" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."chunk_vector" (
	"space" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" halfvec NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_vector_space_content_hash_pk" PRIMARY KEY("space","content_hash")
);
--> statement-breakpoint
ALTER TABLE "memindex"."chunk_vector" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."cursor" (
	"producer_id" text NOT NULL,
	"source" text NOT NULL,
	"location_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cursor_producer_id_source_location_id_name_pk" PRIMARY KEY("producer_id","source","location_id","name")
);
--> statement-breakpoint
ALTER TABLE "memindex"."cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."derived_object" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derived_object_kind_check" CHECK ("memindex"."derived_object"."kind" IN ('vector_index', 'facet_view'))
);
--> statement-breakpoint
ALTER TABLE "memindex"."derived_object" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."item" (
	"item_key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"origin" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"parent_key" text,
	"supersede_key" text,
	"superseded_by" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rev_fidelity" integer NOT NULL,
	"rev_at" double precision,
	"rev_hash" text NOT NULL,
	"rev_producer" text NOT NULL,
	"chunker" text NOT NULL,
	"parser_version" integer NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_kind_check" CHECK ("memindex"."item"."kind" IN ('dictation', 'meeting', 'conversation')),
	CONSTRAINT "item_key_source_check" CHECK ("memindex"."item"."item_key" LIKE "memindex"."item"."source" || ':%')
);
--> statement-breakpoint
ALTER TABLE "memindex"."item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."item_tag" (
	"item_key" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "item_tag_item_key_tag_pk" PRIMARY KEY("item_key","tag")
);
--> statement-breakpoint
ALTER TABLE "memindex"."item_tag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."job_run" (
	"job_id" text NOT NULL,
	"producer_id" text NOT NULL,
	"code_version" integer NOT NULL,
	"state" text NOT NULL,
	"cursor" text,
	"done" bigint DEFAULT 0 NOT NULL,
	"total" bigint,
	"error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_run_job_id_producer_id_pk" PRIMARY KEY("job_id","producer_id"),
	CONSTRAINT "job_run_state_check" CHECK ("memindex"."job_run"."state" IN ('running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "memindex"."job_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."memindex_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memindex"."memindex_meta" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."observation" (
	"item_key" text NOT NULL,
	"producer_id" text NOT NULL,
	"location_id" text NOT NULL,
	"source" text NOT NULL,
	"locator" text NOT NULL,
	"rev_fidelity" integer NOT NULL,
	"rev_at" double precision,
	"rev_hash" text NOT NULL,
	"attachments" jsonb,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	CONSTRAINT "observation_item_key_producer_id_location_id_pk" PRIMARY KEY("item_key","producer_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "memindex"."observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."producer" (
	"producer_id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"binary_version" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memindex"."producer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."turn" (
	"item_key" text NOT NULL,
	"turn_key" text NOT NULL,
	"ord" integer NOT NULL,
	"role" text NOT NULL,
	"at" timestamp with time zone,
	"speaker" text,
	"body" text NOT NULL,
	"parts" jsonb NOT NULL,
	"parts_hash" text NOT NULL,
	CONSTRAINT "turn_item_key_turn_key_pk" PRIMARY KEY("item_key","turn_key")
);
--> statement-breakpoint
ALTER TABLE "memindex"."turn" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memindex"."vector_space" (
	"space_id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"index_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vector_space_dim_check" CHECK ("memindex"."vector_space"."dim" BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "memindex"."vector_space" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memindex"."capture" ADD CONSTRAINT "capture_item_key_item_item_key_fk" FOREIGN KEY ("item_key") REFERENCES "memindex"."item"("item_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."capture" ADD CONSTRAINT "capture_producer_id_producer_producer_id_fk" FOREIGN KEY ("producer_id") REFERENCES "memindex"."producer"("producer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."chunk" ADD CONSTRAINT "chunk_item_key_turn_key_turn_item_key_turn_key_fk" FOREIGN KEY ("item_key","turn_key") REFERENCES "memindex"."turn"("item_key","turn_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."chunk_vector" ADD CONSTRAINT "chunk_vector_space_vector_space_space_id_fk" FOREIGN KEY ("space") REFERENCES "memindex"."vector_space"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."cursor" ADD CONSTRAINT "cursor_producer_id_producer_producer_id_fk" FOREIGN KEY ("producer_id") REFERENCES "memindex"."producer"("producer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."item" ADD CONSTRAINT "item_rev_producer_producer_producer_id_fk" FOREIGN KEY ("rev_producer") REFERENCES "memindex"."producer"("producer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."item_tag" ADD CONSTRAINT "item_tag_item_key_item_item_key_fk" FOREIGN KEY ("item_key") REFERENCES "memindex"."item"("item_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."job_run" ADD CONSTRAINT "job_run_producer_id_producer_producer_id_fk" FOREIGN KEY ("producer_id") REFERENCES "memindex"."producer"("producer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."observation" ADD CONSTRAINT "observation_producer_id_producer_producer_id_fk" FOREIGN KEY ("producer_id") REFERENCES "memindex"."producer"("producer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memindex"."turn" ADD CONSTRAINT "turn_item_key_item_item_key_fk" FOREIGN KEY ("item_key") REFERENCES "memindex"."item"("item_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_item_idx" ON "memindex"."chunk" USING btree ("item_key");--> statement-breakpoint
CREATE INDEX "chunk_source_started_idx" ON "memindex"."chunk" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "chunk_content_hash_idx" ON "memindex"."chunk" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "chunk_tsv_idx" ON "memindex"."chunk" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunk_trgm_idx" ON "memindex"."chunk" USING gin (memindex.immutable_unaccent("text") extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "item_source_started_idx" ON "memindex"."item" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "item_supersede_idx" ON "memindex"."item" USING btree ("source","supersede_key") WHERE "memindex"."item"."supersede_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "item_parent_idx" ON "memindex"."item" USING btree ("parent_key") WHERE "memindex"."item"."parent_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "item_tag_tag_idx" ON "memindex"."item_tag" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "observation_scope_idx" ON "memindex"."observation" USING btree ("producer_id","location_id","source");--> statement-breakpoint
CREATE INDEX "observation_live_idx" ON "memindex"."observation" USING btree ("item_key") WHERE "memindex"."observation"."gone_at" IS NULL;--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."capture" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."chunk" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."chunk_vector" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."cursor" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."derived_object" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."item" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."item_tag" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."job_run" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."memindex_meta" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."observation" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."producer" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."turn" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "writer_all" ON "memindex"."vector_space" AS PERMISSIVE FOR ALL TO "memindex_writer" USING (true) WITH CHECK (true);