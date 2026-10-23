import { z } from "zod";
import pkg from "../package.json";

/** Single source: apps/memindex/package.json, inlined into the compiled binary. */
export const VERSION: string = z.object({ version: z.string().min(1) }).parse(pkg).version;
