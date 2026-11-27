/**
 * Pieces shared by the evaluation runners: the demo database both of them copy, the qa_pair
 * parser and the text a tool result contributes to a conversation.
 *
 * The file uses a ".ts" import specifier so the runners also work on plain Node, which does
 * not remap "./x.js" to "./x.ts" the way Bun does.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export const EVALUATION_FILE = resolve(SCRIPTS_DIR, "..", "evals", "evaluation.xml");

/**
 * The seeded database every runner copies to a temp file before starting the server.
 *
 * Resolved from this file instead of imported from `src/`, because a script cannot reach `src/`
 * on plain Node: type stripping refuses the `enum` in `src/constants.ts`
 * (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), and Node does not remap `src/`'s ".js" specifiers to the
 * ".ts" files (ERR_MODULE_NOT_FOUND). Both reproduce on 22.16 with --experimental-strip-types
 * and on 22.18 by default.
 */
export const DEMO_DB = resolve(SCRIPTS_DIR, "..", "data", "demo.db");

export interface Pair {
  question: string;
  answer: string;
}

/** Reads the qa_pair elements of the evaluation file, decoding XML entities. */
export function parseEvaluation(xml: string): Pair[] {
  const decode = (text: string): string =>
    text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");

  const pairs = [...xml.matchAll(/<qa_pair>([\s\S]*?)<\/qa_pair>/g)].map((pair) => {
    const body = pair[1]!;
    const question = decode(/<question>([\s\S]*?)<\/question>/.exec(body)?.[1]?.trim() ?? "");
    const answer = decode(/<answer>([\s\S]*?)<\/answer>/.exec(body)?.[1]?.trim() ?? "");
    assert.ok(question && answer, "every qa_pair needs both a question and an answer");
    return { question, answer };
  });
  return pairs;
}

export function loadPairs(file = EVALUATION_FILE): Pair[] {
  return parseEvaluation(readFileSync(file, "utf8"));
}

export function toolText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { text?: string }[];
  return content.map((block) => block.text ?? "").join("\n");
}
