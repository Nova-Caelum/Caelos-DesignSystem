#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";

if (process.argv[2] === "--version") {
  process.stdout.write("fixture harness\n");
  process.exit(0);
}
const checkoutIndex = process.argv.indexOf("--cd");
const messageIndex = process.argv.indexOf("--output-last-message");
const checkout = process.argv[checkoutIndex + 1];
writeFileSync(path.join(checkout, "result.json"), "{\"answer\":\"ok\"}\n");
writeFileSync(process.argv[messageIndex + 1], "fixture complete\n");
process.stdout.write(`${JSON.stringify({ type: "turn.started", model: "Opus" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { model: "fixture-allowed-model" } })}\n`);
