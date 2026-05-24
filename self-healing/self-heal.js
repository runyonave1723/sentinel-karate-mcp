#!/usr/bin/env node
/**
 * Sentinel Self-Healing Script
 * Usage: node self-heal.js [--tag @smoke] [--max-retries 3]
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KARATE_DIR = path.join(REPO_ROOT, 'karate-tests');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Parse CLI args
const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const retriesIndex = args.indexOf('--max-retries');
const TAG = tagIndex !== -1 ? args[tagIndex + 1] : null;
const MAX_RETRIES = retriesIndex !== -1 ? parseInt(args[retriesIndex + 1]) : 3;

console.log(`\n🤖 Sentinel Self-Healing Test Runner`);
console.log(`   Tag: ${TAG || 'all'} | Max retries: ${MAX_RETRIES}`);
console.log(`   Karate dir: ${KARATE_DIR}\n`);

async function listFeatureFiles(dir) {
  const result = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await listFeatureFiles(full));
      else if (entry.name.endsWith('.feature')) result.push(full);
    }
  } catch {}
  return result;
}

function extractFailures(output) {
  const failures = [];
  const lines = output.split('\n');
  let current = [];
  let capturing = false;

  for (const line of lines) {
    if (line.match(/FAILED|AssertionError|did not match|expected.*got|match failed/i)) {
      capturing = true;
      current = [line];
    } else if (capturing) {
      current.push(line);
      if (current.length > 20 || (line.trim() === '' && current.length > 5)) {
        failures.push(current.join('\n'));
        capturing = false;
        current = [];
      }
    }
  }
  if (current.length > 0) failures.push(current.join('\n'));
  return failures;
}

async function runTests() {
  let cmd = `cd "${KARATE_DIR}" && mvn test -Dkarate.env=dev -q`;
  if (TAG) cmd += ` -Dkarate.options="--tags ${TAG}"`;

  console.log(`▶ Running: mvn test${TAG ? ' (tag: ' + TAG + ')' : ''}`);
  let output = '';
  let success = false;

  try {
    const result = await execAsync(cmd, { timeout: 180000 });
    output = result.stdout + result.stderr;
    success = true;
  } catch (err) {
    output = (err.stdout || '') + (err.stderr || '');
    success = false;
  }

  // Extract summary line
  const summaryMatch = output.match(/Tests run: \d+, Failures: \d+, Errors: \d+/);
  const summary = summaryMatch ? summaryMatch[0] : 'No summary';
  console.log(`   ${success ? '✅' : '❌'} ${summary}`);

  return { success, output, summary, failures: extractFailures(output) };
}

async function healWithClaude(failures, featureFiles) {
  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set. Cannot self-heal.');
    return [];
  }

  console.log(`\n🔧 Calling Claude (claude-opus-4-5) to analyze ${failures.length} failure(s)...`);

  // Read all feature files
  const fileContents = {};
  for (const f of featureFiles) {
    const rel = f.replace(path.join(KARATE_DIR, 'src', 'test', 'resources') + '/', '');
    fileContents[rel] = await readFile(f, 'utf8');
  }

  const prompt = `You are an expert Karate API test engineer and self-healing agent.

CURRENT FEATURE FILES:
${Object.entries(fileContents).map(([f, c]) => `=== FILE: ${f} ===\n${c}\n`).join('\n')}

TEST FAILURES:
${failures.join('\n\n---\n\n')}

TASK: Analyze each failure carefully. Identify what is wrong in the feature file (wrong assertion, wrong status code, wrong field name, wrong path, wrong request body, etc.) and provide fixes.

Respond with ONLY a valid JSON array — no markdown, no explanation outside the JSON:
[
  {
    "file": "karate/inventory/products.feature",
    "reason": "Brief explanation of the bug and fix",
    "patchedContent": "complete corrected content of the feature file"
  }
]

Important rules:
1. Only include files that need changes
2. Do NOT break passing scenarios
3. Fix the exact assertion/field/status that is failing
4. Return valid Karate DSL syntax`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    console.error('Claude API error:', response.status, await response.text());
    return [];
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '[]';
  const clean = text.replace(/```json\n?|```/g, '').trim();

  try {
    const patches = JSON.parse(clean);
    return patches;
  } catch (e) {
    console.error('Failed to parse Claude response:', e.message);
    console.error('Raw response:', clean.slice(0, 500));
    return [];
  }
}

async function applyPatches(patches) {
  const applied = [];
  for (const patch of patches) {
    if (!patch.file || !patch.patchedContent) continue;
    const fullPath = path.join(KARATE_DIR, 'src', 'test', 'resources', patch.file);
    try {
      // Backup original
      const original = await readFile(fullPath, 'utf8');
      await writeFile(fullPath + '.bak', original);
      // Write patch
      await writeFile(fullPath, patch.patchedContent, 'utf8');
      console.log(`   ✏️  Patched: ${patch.file}`);
      console.log(`      Reason: ${patch.reason}`);
      applied.push(patch.file);
    } catch (e) {
      console.error(`   ❌ Failed to patch ${patch.file}: ${e.message}`);
    }
  }
  return applied;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const featuresBaseDir = path.join(KARATE_DIR, 'src', 'test', 'resources', 'karate');
  const featureFiles = await listFeatureFiles(featuresBaseDir);

  let lastResult;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Attempt ${attempt}/${MAX_RETRIES + 1}`);

    lastResult = await runTests();

    if (lastResult.success || lastResult.failures.length === 0) {
      console.log('\n🎉 All tests passing! Self-healing complete.');
      process.exit(0);
    }

    if (attempt > MAX_RETRIES) {
      console.log(`\n⛔ Max retries (${MAX_RETRIES}) reached. Some failures remain.`);
      break;
    }

    const patches = await healWithClaude(lastResult.failures, featureFiles);
    if (patches.length === 0) {
      console.log('\n⚠️  Claude could not generate patches. Stopping.');
      break;
    }

    const applied = await applyPatches(patches);
    if (applied.length === 0) {
      console.log('\n⚠️  No patches applied. Stopping.');
      break;
    }

    console.log(`\n↻ Re-running tests after patching ${applied.length} file(s)...`);
  }

  process.exit(lastResult?.success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
