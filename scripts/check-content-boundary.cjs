#!/usr/bin/env node

// check-content-boundary.cjs — public-repo content boundary gate for Lookout.
//
// MECHANISM copied from kontourai/traverse (scripts/check-content-boundary.cjs)
// as a temporary per-repo copy; kontourai/veritas#112 is expected to centralize
// this gate across the portfolio. When that lands, re-vendor from the shared
// source instead of hand-editing the logic below.
//
// Lookout's ACTUAL boundary (not traverse's verbatim list): this repo is public
// and must never carry private vertical vocabulary — a private product name or
// any private regulated-vertical term — in newly authored source, tests, docs,
// CONTEXT, README, or config. The terms are built from character arrays so the
// literal never appears in this file.
//
// The pre-existing durable planning archive under docs/planning/ predates this
// gate and openly references a portfolio sibling by name as implementation
// precedent; rewriting that historical record is out of scope for L1, so it is
// EXPLICITLY grandfathered via ignoredPathPatterns below (an allowlisted path,
// not a weakened term list). Every other tracked path is still scanned in full.

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const SELF = "scripts/check-content-boundary.cjs";

const bannedTerms = [
  {
    label: "private vertical product name",
    pattern: new RegExp(["c", "a", "m", "p", "f", "i", "t"].join(""), "i"),
  },
  {
    label: "private regulated vertical repository name",
    pattern: new RegExp("\\b" + ["t", "a", "x", "e", "s"].join("") + "\\b", "i"),
  },
  {
    label: "private regulated vertical term",
    pattern: new RegExp("\\b" + ["t", "a", "x"].join("") + "\\b", "i"),
  },
];

const ignoredPathPatterns = [
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^\.git\//,
  /^test-results\//,
  // Grandfathered pre-existing planning archive (see header). New authored
  // content lives elsewhere and is still fully scanned.
  /^docs\/planning\//,
];

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

function isIgnoredPath(filePath) {
  return filePath === SELF || ignoredPathPatterns.some((pattern) => pattern.test(filePath));
}

function lineNumberFor(content, index) {
  return content.slice(0, index).split("\n").length;
}

const findings = [];

for (const filePath of trackedFiles()) {
  if (filePath.startsWith(".flow-agents/")) {
    findings.push({
      filePath,
      line: 1,
      label: "Flow Agents runtime artifact must not be tracked in this repo",
    });
    continue;
  }

  if (isIgnoredPath(filePath)) {
    continue;
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }

  if (content.includes("\0")) {
    continue;
  }

  for (const term of bannedTerms) {
    const match = term.pattern.exec(content);
    if (match) {
      findings.push({
        filePath,
        line: lineNumberFor(content, match.index),
        label: term.label,
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Content boundary check failed:");
  for (const finding of findings) {
    console.error(`- ${finding.filePath}:${finding.line} ${finding.label}`);
  }
  process.exit(1);
}

console.log("Content boundary check passed.");
