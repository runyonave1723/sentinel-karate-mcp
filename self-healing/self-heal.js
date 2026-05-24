#!/usr/bin/env node
/**
 * Sentinel Self-Healing Script - reads Karate JSON reports for accurate failure detection
 * Usage: node self-heal.js [--tag @smoke] [--max-retries 3] [--debug] [--key sk-ant-...]
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KARATE_DIR = path.join(REPO_ROOT, 'karate-tests');

// Parse CLI args
const args = process.argv.slice(2);
const tagIndex     = args.indexOf('--tag');
const retriesIndex = args.indexOf('--max-retries');
const keyIndex     = args.indexOf('--key');
const TAG          = tagIndex     !== -1 ? args[tagIndex + 1]     : null;
const MAX_RETRIES  = retriesIndex !== -1 ? parseInt(args[retriesIndex + 1]) : 3;
const DEBUG        = args.includes('--debug');
const CLI_KEY      = keyIndex !== -1 ? args[keyIndex + 1] : null;

let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || CLI_KEY || null;

// Map tag to JUnit5 method
function getTestMethod(tag) {
  if (!tag) return 'runAllTests';
  const t = tag.replace('@', '').toLowerCase();
  const map = { smoke: 'runSmokeTests', inventory: 'runInventoryTests', orders: 'runOrderTests' };
  return map[t] || 'runAllTests';
}

console.log(`\n🤖 Sentinel Self-Healing Test Runner`);
console.log(`   Tag: ${TAG || 'all'} | Max retries: ${MAX_RETRIES} | Debug: ${DEBUG}`);
console.log(`   Karate dir: ${KARATE_DIR}\n`);

// ─── List feature files ───────────────────────────────────────────────────────

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

// ─── Parse Karate JSON report for failures ────────────────────────────────────

async function parseKarateReport() {
  const reportDir = path.join(KARATE_DIR, 'target', 'surefire-reports');
  const karateReportDir = path.join(KARATE_DIR, 'target', 'karate-reports');

  const failures = [];
  let totalScenarios = 0;
  let failedScenarios = 0;

  // Try karate-reports JSON files first (most detailed)
  try {
    const files = await readdir(karateReportDir);
    const jsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('summary'));

    for (const file of jsonFiles) {
      const content = await readFile(path.join(karateReportDir, file), 'utf8');
      const report = JSON.parse(content);

      // Karate report structure: array of features
      const elements = report.elements || report || [];
      for (const element of elements) {
        if (!element.steps) continue;
        totalScenarios++;
        const failed = element.steps.some(s => s.result?.status === 'failed');
        if (failed) {
          failedScenarios++;
          const failedSteps = element.steps
            .filter(s => s.result?.status === 'failed')
            .map(s => `  Step: ${s.name}\n  Error: ${s.result?.error_message || 'unknown'}`)
            .join('\n');
          failures.push(`FEATURE: ${file}\nSCENARIO: ${element.name}\n${failedSteps}`);
        }
      }
    }
  } catch (e) {
    if (DEBUG) console.log(`   karate-reports parse: ${e.message}`);
  }

  // Try karate-summary.json
  if (failures.length === 0) {
    try {
      const summaryPath = path.join(karateReportDir, 'karate-summary.json');
      const content = await readFile(summaryPath, 'utf8');
      const summary = JSON.parse(content);

      if (DEBUG) console.log('   karate-summary:', JSON.stringify(summary).slice(0, 500));

      totalScenarios = summary.scenarioCount || 0;
      failedScenarios = summary.scenariosFailed || 0;

      if (failedScenarios > 0 && summary.featureSummary) {
        for (const feat of summary.featureSummary) {
          if (feat.failed > 0) {
            failures.push(`FEATURE: ${feat.relativePath}\nFailed scenarios: ${feat.failed}\nScenario results: ${JSON.stringify(feat.scenarioResults || {})}`);
          }
        }
      }
    } catch (e) {
      if (DEBUG) console.log(`   karate-summary parse: ${e.message}`);
    }
  }

  return { failures, totalScenarios, failedScenarios };
}

// ─── Run tests ────────────────────────────────────────────────────────────────

async function runTests() {
  const method = getTestMethod(TAG);
  const cmd = `cd "${KARATE_DIR}" && mvn test -Dtest=KarateTestRunner#${method} -Dsurefire.failIfNoSpecifiedTests=false`;

  console.log(`▶ Running: KarateTestRunner#${method}`);

  let output = '';
  let mvnSuccess = false;

  try {
    const result = await execAsync(cmd, { timeout: 180000 });
    output = result.stdout + result.stderr;
    mvnSuccess = true;
  } catch (err) {
    output = (err.stdout || '') + (err.stderr || '');
    mvnSuccess = false;
  }

  if (DEBUG) {
    console.log('\n─── RAW MVN OUTPUT (last 60 lines) ───');
    console.log(output.split('\n').slice(-60).join('\n'));
    console.log('──────────────────────────────────────\n');
  }

  // Parse Karate's own JSON report — much more accurate than Maven output
  const { failures, totalScenarios, failedScenarios } = await parseKarateReport();

  const success = mvnSuccess && failedScenarios === 0;
  console.log(`   ${success ? '✅' : '❌'} Scenarios: ${totalScenarios} total, ${failedScenarios} failed`);
  console.log(`   🔍 Failures extracted: ${failures.length}`);

  if (DEBUG && failures.length > 0) {
    console.log('\n─── EXTRACTED FAILURES ───');
    failures.forEach((f, i) => console.log(`\n[Failure ${i + 1}]\n${f}`));
    console.log('──────────────────────────\n');
  }

  return { success, output, failures, totalScenarios, failedScenarios };
}

// ─── Self-heal with Claude ────────────────────────────────────────────────────

async function healWithClaude(failures, featureFiles) {
  if (!ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set!');
    console.error('   Git Bash: export ANTHROPIC_API_KEY="sk-ant-..."');
    console.error('   Or pass:  node self-heal.js --key sk-ant-...');
    return [];
  }

  console.log(`\n🔧 Calling Claude (claude-opus-4-5) to analyze ${failures.length} failure(s)...`);

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

TASK: Analyze each failure and identify what is wrong in the feature file.
Common issues: wrong status code assertion (e.g. 199 instead of 200), wrong field name, wrong path.

Respond with ONLY a valid JSON array — no markdown, no backticks:
[
  {
    "file": "karate/orders/orders.feature",
    "reason": "Brief explanation of what was wrong and what was fixed",
    "patchedContent": "...complete corrected content of the feature file..."
  }
]

Rules:
1. Only include files that need changes
2. Do NOT break passing scenarios
3. Return ONLY valid JSON — no markdown fences`;

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
      console.log(text.slice(0, 2000));
      console.log('───────────────────────\n');
    }

    const clean = text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`   ❌ Claude call failed: ${e.message}`);
    return [];
  }
}

// ─── Apply patches ────────────────────────────────────────────────────────────

async function applyPatches(patches, featureFiles) {
  const applied = [];
  for (const patch of patches) {
    if (!patch.file || !patch.patchedContent) continue;

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
    console.error('   Git Bash: export ANTHROPIC_API_KEY="sk-ant-..."');
    console.error('   Or pass:  node self-heal.js --key sk-ant-...');
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
      console.log('   Run with --debug to inspect raw output and failures.');
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
