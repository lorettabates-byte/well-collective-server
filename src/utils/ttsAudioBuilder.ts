import ffmpegPath from "ffmpeg-static";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FFMPEG = ffmpegPath as unknown as string;

export type ScriptSegment =
  | { type: "speech"; text: string }
  | { type: "count"; from: number; to: number }
  | { type: "pause"; ms: number };

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ttsbuild-"));

// Spawns the ffmpeg-static binary directly with an explicit argv, bypassing
// fluent-ffmpeg's automatic capability check (`ffmpeg -formats` parsing),
// which misreports the lavfi demuxer as unavailable on Railway's Linux binary
// even though the binary itself supports it.
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 64 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// gpt-4o-mini-tts takes free-text delivery direction, which the older
// tts-1-hd model couldn't — this is what makes the guide sound like a
// meditation teacher instead of a screen reader.
const VOICE_INSTRUCTIONS =
  "You are a meditation and breathwork guide. Speak very slowly, softly, and warmly, " +
  "in a low, soothing, unhurried voice — like guiding someone toward sleep. " +
  "Leave gentle space around your words. Never sound bright, chipper, or announcer-like.";

async function synthesizeRaw(text: string): Promise<Buffer> {
  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "sage",
    input: text,
    instructions: VOICE_INSTRUCTIONS,
  });
  return Buffer.from(await mp3.arrayBuffer());
}

// Warms up the raw TTS output: cuts rumble/sibilance and adds gentle compression so it
// sounds closer to a close-mic podcast recording instead of a thin synthetic clip.
async function warmAndClean(buffer: Buffer): Promise<Buffer> {
  const dir = tmpDir();
  const inPath = path.join(dir, "in.mp3");
  const outPath = path.join(dir, "out.mp3");
  fs.writeFileSync(inPath, buffer);
  await runFfmpeg([
    "-y",
    "-i", inPath,
    "-af", "highpass=f=90,lowpass=f=9000,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120,volume=1.15",
    outPath,
  ]);
  const result = fs.readFileSync(outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

async function padOrTrimToExactly(buffer: Buffer, ms: number): Promise<Buffer> {
  const dir = tmpDir();
  const inPath = path.join(dir, "in.mp3");
  const outPath = path.join(dir, "out.mp3");
  fs.writeFileSync(inPath, buffer);
  const seconds = (ms / 1000).toFixed(3);
  await runFfmpeg([
    "-y",
    "-i", inPath,
    "-af", `apad=whole_dur=${seconds},atrim=0:${seconds}`,
    outPath,
  ]);
  const result = fs.readFileSync(outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

async function generateSilence(ms: number): Promise<Buffer> {
  const dir = tmpDir();
  const outPath = path.join(dir, "silence.mp3");
  const seconds = (ms / 1000).toFixed(3);
  await runFfmpeg([
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=mono:sample_rate=24000",
    "-t", seconds,
    outPath,
  ]);
  const result = fs.readFileSync(outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

async function concatBuffers(buffers: Buffer[]): Promise<Buffer> {
  const dir = tmpDir();
  const listPath = path.join(dir, "list.txt");
  const outPath = path.join(dir, "out.mp3");

  const lines: string[] = [];
  buffers.forEach((buf, i) => {
    const p = path.join(dir, `part-${i}.mp3`);
    fs.writeFileSync(p, buf);
    lines.push(`file '${p}'`);
  });
  fs.writeFileSync(listPath, lines.join("\n"));

  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c:a", "libmp3lame",
    // Mono voice tracks don't need more — keeps the full-length session
    // guides (10-30 min) small enough to cache and stream comfortably.
    "-b:a", "64k",
    "-ac", "1",
    outPath,
  ]);

  const result = fs.readFileSync(outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

// Each spoken number, generated once and trimmed/padded to exactly one second,
// so counted breath holds always land one second apart regardless of how fast
// or slow the model naturally speaks that word.
const numberWords = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
const numberClipCache = new Map<number, Buffer>();

async function getNumberClip(n: number): Promise<Buffer> {
  if (numberClipCache.has(n)) return numberClipCache.get(n)!;
  const raw = await synthesizeRaw(numberWords[n - 1] + ".");
  const warmed = await warmAndClean(raw);
  const exact = await padOrTrimToExactly(warmed, 1000);
  numberClipCache.set(n, exact);
  return exact;
}

const speechCache = new Map<string, Buffer>();

async function getSpeechClip(text: string): Promise<Buffer> {
  if (speechCache.has(text)) return speechCache.get(text)!;
  const raw = await synthesizeRaw(text);
  const warmed = await warmAndClean(raw);
  speechCache.set(text, warmed);
  return warmed;
}

const silenceCache = new Map<number, Buffer>();

async function getSilence(ms: number): Promise<Buffer> {
  if (silenceCache.has(ms)) return silenceCache.get(ms)!;
  const sil = await generateSilence(ms);
  silenceCache.set(ms, sil);
  return sil;
}

// Breathing room between sentences — meditation pacing wants real gaps,
// not conversational ones.
const SENTENCE_PAUSE_MS = 1500;

// Rough duration model for a segment list, used to size scripts to a target
// length before synthesizing anything. Speech is modeled at ~0.45s/word at the
// slow meditative delivery; counts are exactly 1s per number (see getNumberClip).
export function estimateSeconds(segments: ScriptSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.type === "speech") {
      const words = segment.text.split(/\s+/).filter(Boolean).length;
      total += 0.5 + words * 0.45 + SENTENCE_PAUSE_MS / 1000;
    } else if (segment.type === "count") {
      total += (segment.to - segment.from + 1) + SENTENCE_PAUSE_MS / 1000;
    } else {
      total += segment.ms / 1000;
    }
  }
  return total;
}

export async function buildScriptAudio(segments: ScriptSegment[]): Promise<Buffer> {
  const parts: Buffer[] = [];

  for (const segment of segments) {
    if (segment.type === "speech") {
      parts.push(await getSpeechClip(segment.text));
      parts.push(await getSilence(SENTENCE_PAUSE_MS));
    } else if (segment.type === "count") {
      for (let n = segment.from; n <= segment.to; n++) {
        parts.push(await getNumberClip(n));
      }
      parts.push(await getSilence(SENTENCE_PAUSE_MS));
    } else if (segment.type === "pause") {
      parts.push(await getSilence(segment.ms));
    }
  }

  return concatBuffers(parts);
}
