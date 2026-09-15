import fs from "node:fs/promises";
import path from "node:path";
import type {
  CodeReadingKnowledgeOutput,
  CodeReadingKnowledgeSymbol,
} from "@/lib/types";

function html(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeKnowledgeSegment(value: string, fallback: string) {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 100);
  return normalized || fallback;
}

function list(title: string, values: string[]) {
  if (values.length === 0) return "";
  return `<section><h2>${html(title)}</h2><ul>${values
    .map((value) => `<li>${html(value)}</li>`)
    .join("")}</ul></section>`;
}

function table(
  title: string,
  headers: string[],
  rows: string[][],
) {
  if (rows.length === 0) return "";
  return `<section><h2>${html(title)}</h2><table><thead><tr>${headers
    .map((header) => `<th>${html(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((value) => `<td>${html(value)}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table></section>`;
}

export function renderCodeReadingKnowledgeHtml(options: {
  projectName: string;
  repositoryCommit: string;
  generatedAt: string;
  gapType: string;
  summary: string;
  symbol: CodeReadingKnowledgeSymbol;
}) {
  const symbol = options.symbol;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(symbol.name)} code-reading knowledge</title>
<style>
body{font-family:system-ui,sans-serif;line-height:1.5;max-width:1100px;margin:40px auto;padding:0 24px;color:#1f2328}
h1,h2{line-height:1.2}h2{margin-top:28px;border-bottom:1px solid #d0d7de;padding-bottom:6px}
code{background:#f6f8fa;padding:2px 5px;border-radius:4px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d0d7de;padding:8px;text-align:left;vertical-align:top}th{background:#f6f8fa}
.meta{color:#57606a}.warning{border-left:4px solid #bf8700;padding:8px 12px;background:#fff8c5}
</style>
</head>
<body>
<h1>${html(symbol.name)}</h1>
<p class="meta"><strong>Project:</strong> ${html(options.projectName)} · <strong>Kind:</strong> ${html(symbol.kind)} · <strong>Source:</strong> <code>${html(symbol.sourcePath)}</code></p>
<p class="meta"><strong>Repository commit:</strong> <code>${html(options.repositoryCommit)}</code> · <strong>Refreshed:</strong> ${html(options.generatedAt)}</p>
<p><strong>Gap type:</strong> ${html(options.gapType)}</p>
<p>${html(options.summary)}</p>
<section><h2>Purpose and usage</h2><p>${html(symbol.purpose)}</p></section>
${list("Usage sites and rationale", symbol.usages)}
${table(
    "Similar symbols and differences",
    ["Symbol", "Source", "Similarities", "Differences"],
    symbol.similarSymbols.map((item) => [
      item.name,
      item.sourcePath,
      item.similarities,
      item.differences,
    ]),
  )}
${table(
    "Inputs",
    ["Input", "Type", "Valid or possible values", "Invalid/error behavior"],
    symbol.inputs.map((item) => [
      item.name,
      item.type,
      item.validValues,
      item.invalidBehavior,
    ]),
  )}
${table(
    "Outputs",
    ["Output", "Type", "Expected values", "Meaning"],
    symbol.outputs.map((item) => [
      item.name,
      item.type,
      item.expectedValues,
      item.meaning,
    ]),
  )}
${list("Exception and error propagation", symbol.errorBehavior)}
${table(
    "Dependencies and relationships",
    ["Dependency", "Kind", "Relationship"],
    symbol.dependencies.map((item) => [
      item.name,
      item.kind,
      item.relationship,
    ]),
  )}
${list("Call flow", symbol.callFlow)}
${list("Invariants and contracts", symbol.invariants)}
${list("Evidence", symbol.evidence)}
${symbol.uncertainties.length > 0 ? `<section class="warning"><h2>Uncertainties</h2><ul>${symbol.uncertainties.map((value) => `<li>${html(value)}</li>`).join("")}</ul></section>` : ""}
</body>
</html>
`;
}

export async function writeCodeReadingKnowledge(options: {
  skillRoot: string;
  backupRoot: string;
  projectName: string;
  repositoryCommit: string;
  generatedAt: string;
  output: CodeReadingKnowledgeOutput;
}) {
  const projectSegment = safeKnowledgeSegment(
    options.projectName,
    "unknown-project",
  );
  const written: string[] = [];
  for (const symbol of options.output.symbols) {
    const symbolSegment = safeKnowledgeSegment(symbol.name, "unknown-symbol");
    const relativePath = path.join(
      "Reviewers",
      "CodeReading",
      projectSegment,
      symbolSegment,
      "knowledge-graph.html",
    );
    const target = path.join(options.skillRoot, relativePath);
    const backup = path.join(options.backupRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      const current = await fs.readFile(target);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.writeFile(
      target,
      renderCodeReadingKnowledgeHtml({
        projectName: options.projectName,
        repositoryCommit: options.repositoryCommit,
        generatedAt: options.generatedAt,
        gapType: options.output.gapType,
        summary: options.output.summary,
        symbol,
      }),
    );
    written.push(relativePath.replaceAll("\\", "/"));
  }
  return written;
}
