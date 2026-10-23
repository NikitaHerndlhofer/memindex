import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: process.env.MEMINDEX_DRIZZLE_OUT ?? "../../supabase/migrations",
  migrations: { prefix: "supabase" },
  schemaFilter: ["memindex"],
});
