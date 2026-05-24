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
// API key: env var or --key CLI arg
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Parse CLI args
const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const retriesIndex = args.indexOf('--max-retries');
const keyIndex = args.indexOf('--key');
const TAG = tagIndex !== -1 ? args[tagIndex + 1] : null;
const MAX_RETRIES = retriesIndex !== -1 ? parseInt(args[retriesIndex + 1]) : 3;
const DEBUG = args.includes('--debug');
// --key lets you pass API key inline (fallback for Windows env var issues)
const CLI_KEY = keyIndex !== -1 ? args[keyIndex + 1] : null;

// Map CLI tag to JUnit5 test method name in KarateTestRunner
function getTestMethod(tag) {
  if (!tag) return 'runAllTests';
  const t = tag.replace('@', '').toLowerCase();
  const map = {
    smoke:     'runSmokeTests',
    inventory: 'runInventoryTests',
    orders:    'runOrderTests'
  };
  return map[t] || 'runAllTests';
}

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
    /assert.*failed/i,
    /karate.*FAIL/i,
    /^\s*\* status \d+/,
    /html.* was:/i
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFailure = failurePatterns.some(p => p.test(line));

    if (isFailure && !capturing) {
      capturing = true;
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

  // Fallback: build failed but no specific pattern matched → send last 150 lines
  if (failures.length === 0 && output.includes('BUILD FAILURE')) {
    console.log('   ⚠️  No specific failure pattern matched — sending full build output to Claude');
    failures.push(output.split('\n').slice(-150).join('\n'));
  }

  return failures;
}

async function runTests() {
  const method = getTestMethod(TAG);

  // Run specific JUnit5 test method — this is reliable in Karate 1.4.1
  // -Dsurefire.failIfNoSpecifiedTests=false prevents error when filtering
  const cmd = `cd "${KARATE_DIR}" && mvn test -Dtest=KarateTestRunner#${method} -Dsurefire.failIfNoSpecifiedTests=false`;

  console.log(`▶ Running: KarateTestRunner#${method}`);

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
    console.log('\n─── RAW OUTPUT (last 100 lines) ───');
    console.log(output.split('\n').slice(-100).join('\n'));
    console.log('───────────────────────────────────\n');
  }

  // Karate prints its own summary line
  const summaryMatch = output.match(/Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+/);
  const karateMatch  = output.match(/scenarios.*failed/i);
  const buildResult  = output.includes('BUILD SUCCESS') ? 'BUILD SUCCESS' : 'BUILD FAILURE';

  const summary = summaryMatch
    ? summaryMatch[0]
    : karateMatch
    ? karateMatch[0]
    : buildResult;

  console.log(`   ${success ? '✅' : '❌'} ${summary}`);

  const failures = extractFailures(output);
  console.log(`   🔍 Failures extracted: ${failures.length}`);

  if (DEBUG && failures.length > 0) {
    console.log('\n─── EXTRACTED FAILURES ───');
    failures.forEach((f, i) => console.log(`\n[Failure ${i + 1}]\n${f}`));
    console.log('──────────────────────────\n');
  }

  return { success, output, summary, failures };
}

async function healWithClaude(failures, featureFiles) {
  if (!ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set!');
    console.error('   CMD:  set ANTHROPIC_API_KEY=sk-ant-...');
    return [];
  }

  console.log(`\n🔧 Calling Claude to analyze ${failures.length} failure(s)...`);

  const fileContents = {};
  for (const f of featureFiles) {
    const rel = f
      .replace(path.join(KARATE_DIR, 'src', 'test', 'resources') + path.sep, '')
      .replace(/\\/g, '/');
    fileContents[rel] = await readFile(f, 'utf8');
  }

  const prompt = `You are an expert Karate API test engineer and self-healing agent.

CURRENT FEATURE FILES:
${Object.entries(fileContents).map(([f, c]) => `=== FILE: ${f} ===\n${c}\n`).join('\n')}

TEST FAILURES:
${failures.join('\n\n---\n\n')}

TASK: Analyze the failures and identify what is wrong in the feature files.
Common issues: wrong status code assertion, wrong field name, wrong HTTP method, wrong path, wrong request body.

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
2. Do NOT break passing scenarios
3. Fix only the exact assertion that is failing
4. Return ONLY valid JSON — no markdown fences`;

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
      console.error(`   ❌ Claude API error ${response.status}: ${await response.text()}`);
      return [];
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    if (DEBUG) {
      console.log('\n─── CLAUDE RESPONSE ───');
      console.log(text.slice(0, 1500));
      console.log('───────────────────────\n');
    }

    const clean = text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`   ❌ Claude call/parse failed: ${e.message}`);
    return [];
  }
}

async function applyPatches(patches, featureFiles) {
  const applied = [];
  for (const patch of patches) {
    if (!patch.file || !patch.patchedContent) continue;

    // Find the actual file path (handle Windows backslashes)
    const normalizedPatch = patch.file.replace(/\\/g, '/');
    let fullPath = path.join(KARATE_DIR, 'src', 'test', 'resources', patch.file);

    const match = featureFiles.find(f =>
      f.replace(/\\/g, '/').includes(normalizedPatch) ||
      path.basename(f) === path.basename(patch.file)
    );
    if (match) fullPath = match;

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is not set.');
    console.error('   CMD:  set ANTHROPIC_API_KEY=sk-ant-...');
    console.error('   Bash: export ANTHROPIC_API_KEY=sk-ant-...');
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
      console.log(`\n⛔ Max retries (${MAX_RETRIES}) reached. Failures remain.`);
      console.log('   Run with --debug to see raw output and failures extracted.');
      break;
    }

    const patches = await healWithClaude(lastResult.failures, featureFiles);
    if (patches.length === 0) {
      console.log('\n⚠️  Claude generated no patches. Stopping.');
      break;
    }

    const applied = await applyPatches(patches, featureFiles);
    if (applied.length === 0) {
      console.log('\n⚠️  No patches applied. Stopping.');
      break;
    }

    console.log(`\n↻ Re-running after patching ${applied.length} file(s)...`);
  }

  process.exit(lastResult?.success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
