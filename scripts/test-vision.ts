#!/usr/bin/env tsx
import "dotenv/config";
import fs from "fs";
import { visionComplete } from "../parody-engine/sglang.js";
import { config } from "../config/index.js";

const buf = fs.readFileSync("smoke-output/thumbnail_7680909052813053217.jpg");
const uri = "data:image/jpeg;base64," + buf.toString("base64");

console.log(`Testing vision → ${config.inference.vision.model} @ ${config.inference.vision.baseUrl}`);
const result = await visionComplete(
  "Describe what you see in two sentences. What is the main subject and what are they doing?",
  [uri],
  { maxTokens: 1500, temperature: 0 }
);
console.log("\nResult:", result?.slice(0, 400) ?? "null");
process.exit(0);
