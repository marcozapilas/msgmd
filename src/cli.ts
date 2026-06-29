import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { buildMarkdown, parseMsgBytes } from "./core/converter.js";

/** Outcome of processing one input file. */
interface ConversionResult {
  sourceFile: string;
  outputFile?: string;
  status: "converted" | "skipped";
  error?: string;
}

const OUTPUT_DIR = "output";

/** Collect every .msg file under a file or directory path. */
export function collectMsgFiles(inputPath: string): string[] {
  const stat = statSync(inputPath);
  if (stat.isFile()) {
    return isMsg(inputPath) ? [inputPath] : [];
  }
  return readdirSync(inputPath)
    .map((entry) => join(inputPath, entry))
    .filter((entry) => statSync(entry).isFile() && isMsg(entry))
    .sort();
}

function isMsg(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".msg";
}

/** Convert one .msg file and write its Markdown sibling into `outputDir`. */
function convertOne(filePath: string, outputDir: string): ConversionResult {
  try {
    const email = parseMsgBytes(new Uint8Array(readFileSync(filePath)));
    const markdown = buildMarkdown(email);
    const outputFile = uniquePath(
      join(outputDir, `${basename(filePath, extname(filePath))}.md`),
    );
    // UTF-8 keeps Turkish characters (ç, ğ, ı, İ, ö, ş, ü) intact.
    writeFileSync(outputFile, markdown, { encoding: "utf-8" });
    return { sourceFile: filePath, outputFile, status: "converted" };
  } catch (error) {
    return {
      sourceFile: filePath,
      status: "skipped",
      error: (error as Error).message,
    };
  }
}

/** Avoid clobbering when two source files share a base name. */
function uniquePath(candidate: string): string {
  if (!existsSync(candidate)) {
    return candidate;
  }
  const dir = candidate.slice(0, -extname(candidate).length);
  let counter = 1;
  let next = `${dir}-${counter}.md`;
  while (existsSync(next)) {
    counter += 1;
    next = `${dir}-${counter}.md`;
  }
  return next;
}

/** Entry point used by the bin script. */
export function run(argv: string[]): number {
  const inputArg = argv[0];
  if (!inputArg) {
    console.error("Usage: msgmd <file.msg | folder>");
    return 1;
  }

  const inputPath = resolve(inputArg);
  if (!existsSync(inputPath)) {
    console.error(`Input path does not exist: ${inputPath}`);
    return 1;
  }

  const files = collectMsgFiles(inputPath);
  if (files.length === 0) {
    console.error(`No .msg files found at: ${inputPath}`);
    return 1;
  }

  const outputDir = resolve(OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });

  const results = files.map((file) => {
    const result = convertOne(file, outputDir);
    if (result.status === "converted") {
      console.log(`✓ ${basename(file)} -> ${basename(result.outputFile!)}`);
    } else {
      console.warn(`✗ ${basename(file)} skipped: ${result.error}`);
    }
    return result;
  });

  printSummary(results, outputDir);

  const failures = results.filter((r) => r.status === "skipped").length;
  return failures === results.length ? 1 : 0;
}

function printSummary(results: ConversionResult[], outputDir: string): void {
  const converted = results.filter((r) => r.status === "converted");
  const skipped = results.filter((r) => r.status === "skipped");

  console.log("\n──────── Summary ────────");
  console.log(`Total files : ${results.length}`);
  console.log(`Converted   : ${converted.length}`);
  console.log(`Skipped     : ${skipped.length}`);
  console.log(`Output dir  : ${outputDir}`);

  if (skipped.length > 0) {
    console.log("\nSkipped files:");
    for (const result of skipped) {
      console.log(`  - ${basename(result.sourceFile)}: ${result.error}`);
    }
  }
}
