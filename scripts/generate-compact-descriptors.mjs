import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCompactDescriptorSource } from "./compact-descriptor-core.mjs";

const [schemaDir, tsDir, output] = process.argv.slice(2);
if (!schemaDir || !tsDir || !output) throw new Error("Usage: node scripts/generate-compact-descriptors.mjs SCHEMA_DIR TS_DIR OUTPUT");
const methods = [...readFileSync(path.join(tsDir, "ServerNotification.ts"), "utf8").matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]);
writeFileSync(output, buildCompactDescriptorSource(schemaDir, methods), "utf8");
