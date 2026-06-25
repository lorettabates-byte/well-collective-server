import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import OpenAI from "openai";

ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type ScriptSegment =
  | { type: "speech"; text: string }
  | { type: "count"; from: number; to: number }
  | { type: "pause"; ms: number };

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ttsbuild-"));

function runFfmpeg(build: (cmd: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = build(ffmpeg());
    cmd
      .on("error", reject)
      .on("end", () => resolve())
      .save(outputPath);
  });
}

async function synthesizeRaw(text: string): Promise<Buffer> {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1-hd",
    voice: "shimmer",
    input: text,
    speed: 0.95, // sentence-level pacing is handled by inserted pause segments, not by slowing the voice
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
  await runFfmpeg(
    (cmd) =>
      cmd.input(inPath).audioFilters([
        "highpass=f=90",
        "lowpass=f=9000",
        "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120",
        "volume=1.15",
      ]),
    outPath
  );
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
  await runFfmpeg(
    (cmd) =>
      cmd
        .input(inPath)
        .audioFilters([`apad=whole_dur=${seconds}`, `atrim=0:${seconds}`]),
    outPath
  );
  const result = fs.readFileSync(outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

async function generateSilence(ms: number): Promise<Buffer> {
  const dir = tmpDir();
  const outPath = path.join(dir, "silence.mp3");
  const seconds = (ms / 1000).toFixed(3);
  await runFfmpeg(
    (cmd) =>
      cmd
        .input("anullsrc=channel_layout=mono:sample_rate=24000")
        .inputFormat("lavfi")
        .duration(seconds),
    outPath
  );
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

  await runFfmpeg(
    (cmd) => cmd.input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).audioCodec("libmp3lame"),
    outPath
  );

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

const SENTENCE_PAUSE_MS = 650;

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
