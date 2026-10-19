import fs from "node:fs";
import { buildCharacterSwapGraph, characterSwapPrompt, REF2VA_CLIP_FRAMES } from "../parody-engine/ref2va-swap.js";

const prompt = characterSwapPrompt({
  character: "long straight blonde hair, green eyes, white frilled maid headband, black dress with black capelet and black bow, long white frilled apron, flat cel-shaded anime style.",
  source: "two people dancing to a funk track in a vertical TikTok video; the camera, background, lighting, and their motion are kept.",
  motion: "The dance motion, timing, body positions, camera framing, background, and lighting of <Video 1> are fully preserved.",
  soundscape: "The room tone and movement sounds of the original clip.",
  music: "The same upbeat dance rhythm as the original clip.",
});

const graph = buildCharacterSwapGraph({
  characterImage: "idle.png",
  sourceVideo: process.argv[2] ?? "7695020450287488264.ref2va.mp4",
  prompt,
  seed: 42,
  width: 544,
  height: 960,
  length: REF2VA_CLIP_FRAMES,
});

const resp = await fetch("http://10.0.1.99:8188/prompt", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: graph, client_id: "slop-lord" }),
});
const text = await resp.text();
console.log(resp.status, text.slice(0, 2000));
if (!resp.ok) process.exit(1);
fs.writeFileSync("/tmp/slop-ref2va-job.json", text);
