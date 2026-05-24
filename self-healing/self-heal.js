#!/usr/bin/env node
/**
 * Sentinel Self-Healing Script
 * Usage: node self-heal.js [--tag @smoke] [--max-retries 3] [--debug]
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
const DEBUG = args.includes('--debug');

console.log(`\n🤖 Sentinel Self-Healing Test Runner`);
console.log(`   Tag: ${TAG || 'all'} | Max retries: ${MAX_RETRIES} | Debug: ${DEBUG}`);
console.log(`   Karate dir: ${KARATE_DIR}\n`);

async function listFeatureFiles(dir) {
  const result = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await listFeatureFiles(full));
      else if (entry.name.endsWith('.feature') && !entry.name.endsWith('.bak')) result.push(full);
    }
  } catch {}
  return result;
}

function extractFailures(output) {
  const failures = [];
  const lines = output.split('\n');
  let current = [];
  let capturing = false;

  // Comprehensive Karate failure patterns
  const failurePatterns = [
    /FAILED/,
    /AssertionError/i,
    /did not match/i,
    /match failed/i,
    /response status/i,
    /status code was/i,
    /\d{3} != \d{3}/,
    /scenario.*failed/i,
    /not equal/i,
    /expected.*\d{3}/i,
    /\* status \d+/i,
    /html response/i,
    /assert.*failed/i,
    /karate.*FAIL/i
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFailure = failurePatterns.some(p => p.test(line));

    if (isFailure && !capturing) {
      capturing = true;
      // Include 5 lines before for context
      current = lines.slice(Math.max(0, i - 5), i + 1);
    } else if (capturing) {
      current.push(line);
      if (current.length > 40 || (line.trim() === '' && current.length > 10)) {
        failures.push(current.join('\n'));
        capturing = false;
        current = [];
      }
    }
  }
  if (current.length > 0) failures.push(current.join('\n'));

  // Fallback: if nothing matched but build failed, grab last 150 lines
  if (failures.length === 0 && output.includes('BUILD FAILURE')) {
    console.log('   ⚠️  No specific failure patterns matched — sending full build failure to Claude');
    const allLines = output.split('\n');
    failures.push(allLines.slice(-150).join('\n'));
  }

  return failures;
}

async function runTests() {
  // Remove -q flag so we get full Karate output including failure details
  let cmd = `cd "${KARATE_DIR}" && mvn test -Dkarate.env=dev`;
  if (TAG) cmd += ` -Dkarate.options="--tags ${TAG}"`;

  console.log(`▶ Running: mvn test${TAG ? ' --tags ' + TAG : ''}`);

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

  if (DEBUG) {
    console.log('\n─── RAW OUTPUT (last 80 lines) ───');
    console.log(output.split('\n').slice(-80).join('\n'));
    console.log('─────────────────────────────────\n');
  }

  const summaryMatch = output.match(/Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+/);
  const summary = summaryMatch ? summaryMatch[0] : (success ? 'BUILD SUCCESS' : 'BUILD FAILURE');
  console.log(`   ${success ? '✅' : '❌'} ${summary}`);

  const failures = extractFailures(output);
  console.log(`   🔍 Failures detected: ${failures.length}`);

  if (DEBUG && failures.length > 0) {
    console.log('\n─── EXTRACTED FAILURES ───');
    failures.forEach((f, i) => console.log(`\n[Failure ${i+1}]\n${f}`));
    console.log('──────────────────────────\n');
  }

  return { success, output, summary, failures };
}

async function healWithClaude(failures, featureFiles) {
  if (!ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY is not set!');
    console.error('   Run: set ANTHROPIC_API_KEY=your_key_here   (Windows CMD)');
    console.error('   Run: export ANTHROPIC_API_KEY=your_key_here (Mac/Linux)');
    return [];
  }

  console.log(`\n🔧 Calling Claude (claude-opus-4-5) to analyze ${failures.length} failure(s)...`);

  // Read all feature files
  const fileContents = {};
  for (const f of featureFiles) {
    const rel = f.replace(path.join(KARATE_DIR, 'src', 'test', 'resources') + path.sep, '')
                  .replace(/\\/g, '/');
    fileContents[rel] = await readFile(f, 'utf8');
  }

  const prompt = `You are an expert Karate API test engineer and self-healing agent.

CURRENT FEATURE FILES:
${Object.entries(fileContents).map(([f, c]) => `=== FILE: ${f} ===\n${c}\n`).join('\n')}

TEST FAILURES:
${failures.join('\n\n---\n\n')}

TASK: Analyze each failure carefully. The failures show what went wrong when running Karate tests.
Identify what is wrong in the feature file (wrong status code assertion, wrong field name, wrong path, wrong request body, etc.) and provide the corrected file.

Respond with ONLY a valid JSON array — no markdown, no backticks, no explanation outside the JSON:
[
  {
    "file": "karate/orders/orders.feature",
    "reason": "Brief explanation of bug and fix",
    "patchedContent": "...complete corrected content of the feature file..."
  }
]

Rules:
1. Only include files that actually need changes
2. Do NOT break passing scenarios — only fix the failing ones
3. Fix the exact assertion/status code/field that is failing
4. Return ONLY valid JSON, no markdown code blocks`;

  try {
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
      const errText = await response.text();
      console.error(`   ❌ Claude API error ${response.status}: ${errText}`);
      return [];
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    if (DEBUG) {
      console.log('\n─── CLAUDE RESPONSE ───');
      console.log(text.slice(0, 1000));
      console.log('───────────────────────\n');
    }

    // Strip any accidental markdown fences
    const clean = text.replace(/```json\n?|```/g, '').trim();

    const patches = JSON.parse(clean);
    return patches;
  } catch (e) {
    console.error(`   ❌ Failed to call/parse Claude: ${e.message}`);
    return [];
  }
}

async function applyPatches(patches, featureFiles) {
  const applied = [];
  for (const patch of patches) {
    if (!patch.file || !patch.patchedContent) continue;

    // Try direct path first, then search
    let fullPath = path.join(KARATE_DIR, 'src', 'test', 'resources', patch.file);

    // Also search by filename in case path separator differs
    if (!featureFiles.find(f => f.replace(/\\/g, '/').includes(patch.file.replace(/\\/g, '/')))) {
      const fileName = path.basename(patch.file);
      const match = featureFiles.find(f => path.basename(f) === fileName);
      if (match) fullPath = match;
    }

    try {
      const original = await readFile(fullPath, 'utf8');
      await writeFile(fullPath + '.bak', original);
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
  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is not set. Self-healing requires it.');
    console.error('   CMD:   set ANTHROPIC_API_KEY=sk-ant-...');
    console.error('   Bash:  export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const featuresBaseDir = path.join(KARATE_DIR, 'src', 'test', 'resources', 'karate');
  const featureFiles = await listFeatureFiles(featuresBaseDir);
  console.log(`   📁 Found ${featureFiles.length} feature file(s)`);

  let lastResult;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`Attempt ${attempt}/${MAX_RETRIES + 1}`);
    console.log('─'.repeat(55));

    lastResult = await runTests();

    if (lastResult.success && lastResult.failures.length === 0) {
      console.log('\n🎉 All tests passing! Self-healing complete.');
      process.exit(0);
    }

    if (attempt > MAX_RETRIES) {
      console.log(`\n⛔ Max retries (${MAX_RETRIES}) reached. Some failures remain.`);
      console.log('   Tip: Run with --debug to see raw output and extracted failures');
      break;
    }

    const patches = await healWithClaude(lastResult.failures, featureFiles);

    if (patches.length === 0) {
      console.log('\n⚠️  Claude could not generate patches. Stopping.');
      console.log('   Tip: Run with --debug to see what Claude received');
      break;
    }

    const applied = await applyPatches(patches, featureFiles);
    if (applied.length === 0) {
      console.log('\n⚠️  No patches could be applied. Stopping.');
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
