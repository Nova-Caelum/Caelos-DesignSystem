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
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", arguments: { model: process.env.ENGINE_STUB_STREAM_MODEL || "stream-authored-model" } } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
