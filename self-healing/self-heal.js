#!/usr/bin/env node
/**
 * Sentinel Self-Healing Script
 * Supports: Ollama (local/free) or Claude API
 *
 * Usage:
 *   node self-heal.js --tag @orders --max-retries 3
 *   node self-heal.js --provider ollama --model llama3.1
 *   node self-heal.js --provider claude --key sk-ant-...
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const KARATE_DIR = path.join(REPO_ROOT, 'karate-tests');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args          = process.argv.slice(2);
const get           = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const TAG           = get('--tag');
const MAX_RETRIES   = parseInt(get('--max-retries') || '3');
const DEBUG         = args.includes('--debug');
const PROVIDER      = get('--provider') || 'ollama';          // ollama | claude
const MODEL         = get('--model')    || (PROVIDER === 'claude' ? 'claude-opus-4-5' : 'llama3.1');
const CLI_KEY       = get('--key');
const CLAUDE_KEY    = process.env.ANTHROPIC_API_KEY || CLI_KEY || null;
const OLLAMA_URL    = get('--ollama-url') || 'http://localhost:11434';

function getTestMethod(tag) {
  if (!tag) return 'runAllTests';
  const t = tag.replace('@', '').toLowerCase();
  return { smoke: 'runSmokeTests', inventory: 'runInventoryTests', orders: 'runOrderTests' }[t] || 'runAllTests';
}

console.log(`\n🤖 Sentinel Self-Healing Test Runner`);
console.log(`   Provider: ${PROVIDER} | Model: ${MODEL}`);
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

// ─── Parse Karate JSON reports ────────────────────────────────────────────────
async function parseKarateJsonReports() {
  const failures = [];
  let totalScenarios = 0;
  let failedScenarios = 0;

  const possibleDirs = [
    path.join(KARATE_DIR, 'target', 'karate-reports'),
    path.join(KARATE_DIR, 'target', 'cucumber-json'),
    path.join(KARATE_DIR, 'target', 'surefire-reports'),
  ];

  let reportDir = null;
  let jsonFiles = [];

  for (const dir of possibleDirs) {
    try {
      const files = await readdir(dir);
      const jsons = files.filter(f => f.endsWith('.json'));
      if (jsons.length > 0) {
        reportDir = dir;
        jsonFiles = jsons;
        if (DEBUG) console.log(`   📂 Reports found in: ${dir}`);
        break;
      }
    } catch {}
  }

  if (!reportDir) {
    if (DEBUG) console.log('   ⚠️  No JSON report dirs found');
    return { failures, totalScenarios, failedScenarios, found: false };
  }

  for (const file of jsonFiles) {
    try {
      const content = await readFile(path.join(reportDir, file), 'utf8');
      const features = JSON.parse(content);
      const arr = Array.isArray(features) ? features : [features];

      for (const feature of arr) {
        const elements = feature.elements || [];
        for (const scenario of elements) {
          if (scenario.keyword === 'Background') continue;
          totalScenarios++;
          const steps = scenario.steps || [];
          const failedSteps = steps.filter(s => s.result?.status === 'failed');
          if (failedSteps.length > 0) {
            failedScenarios++;
            const stepDetails = failedSteps.map(s =>
              `  Step: ${s.keyword} ${s.name}\n  Error: ${(s.result?.error_message || 'unknown').slice(0, 400)}`
            ).join('\n');
            failures.push(
              `FEATURE: ${feature.name || file}\n` +
              `SCENARIO: ${scenario.name}\n` +
              `TAGS: ${(scenario.tags || []).map(t => t.name).join(', ')}\n` +
              `${stepDetails}`
            );
          }
        }
      }
    } catch (e) {
      if (DEBUG) console.log(`   ⚠️  Could not parse ${file}: ${e.message}`);
    }
  }

  return { failures, totalScenarios, failedScenarios, found: true };
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
    console.log('\n─── RAW MVN OUTPUT (last 80 lines) ───');
    console.log(output.split('\n').slice(-80).join('\n'));
    console.log('──────────────────────────────────────\n');
  }

  const report = await parseKarateJsonReports();
  const { failures, totalScenarios, failedScenarios } = report;
  const success = mvnSuccess && failedScenarios === 0;

  if (totalScenarios > 0) {
    console.log(`   ${success ? '✅' : '❌'} Scenarios: ${totalScenarios} total, ${failedScenarios} failed`);
  } else {
    console.log(`   ${mvnSuccess ? '✅' : '❌'} Build: ${mvnSuccess ? 'SUCCESS' : 'FAILURE'}`);
  }
  console.log(`   🔍 Failures extracted: ${failures.length}`);

  if (DEBUG && failures.length > 0) {
    console.log('\n─── EXTRACTED FAILURES ───');
    failures.forEach((f, i) => console.log(`\n[Failure ${i + 1}]\n${f}`));
    console.log('──────────────────────────\n');
  }

  return { success, output, failures, totalScenarios, failedScenarios };
}

// ─── Build prompt ─────────────────────────────────────────────────────────────
function buildPrompt(failures, fileContents) {
  return `You are an expert Karate API test engineer and self-healing agent.

CURRENT FEATURE FILES:
${Object.entries(fileContents).map(([f, c]) => `=== FILE: ${f} ===\n${c}\n`).join('\n')}

TEST FAILURES:
${failures.join('\n\n---\n\n')}

TASK: Analyze the failures and identify what is wrong in the feature files.
Common issues: wrong status code (e.g. 199 instead of 200), wrong field name, wrong path.

Respond with ONLY a valid JSON array — no markdown, no backticks, no explanation:
[
  {
    "file": "karate/orders/orders.feature",
    "reason": "Status code assertion was 199, corrected to 200",
    "patchedContent": "...complete corrected content of the feature file..."
  }
]

Rules:
1. Only include files that need changes
2. Do NOT break passing scenarios
3. Return ONLY valid JSON — no markdown fences, no extra text`;
}

// ─── Call Ollama (local, free) ────────────────────────────────────────────────
async function callOllama(prompt) {
  console.log(`   🦙 Calling Ollama (${MODEL}) at ${OLLAMA_URL}...`);

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,   // low temp for deterministic code fixes
        num_predict: 4096
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.response || '';
}

// ─── Call Claude API ──────────────────────────────────────────────────────────
async function callClaude(prompt) {
  if (!CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY not set. Use --key or export env var.');

  console.log(`   🤖 Calling Claude API (${MODEL})...`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ─── Heal with AI ─────────────────────────────────────────────────────────────
async function healWithAI(failures, featureFiles) {
  console.log(`\n🔧 Analyzing ${failures.length} failure(s) with ${PROVIDER}/${MODEL}...`);

  const fileContents = {};
  for (const f of featureFiles) {
    const rel = f
      .replace(path.join(KARATE_DIR, 'src', 'test', 'resources') + path.sep, '')
      .replace(/\\/g, '/');
    fileContents[rel] = await readFile(f, 'utf8');
  }

  const prompt = buildPrompt(failures, fileContents);

  let rawText = '';
  try {
    if (PROVIDER === 'claude') {
      rawText = await callClaude(prompt);
    } else {
      rawText = await callOllama(prompt);
    }
  } catch (e) {
    console.error(`   ❌ AI call failed: ${e.message}`);
    if (PROVIDER === 'ollama') {
      console.error('   💡 Is Ollama running? Try: ollama serve');
      console.error(`   💡 Is the model pulled? Try: ollama pull ${MODEL}`);
    }
    return [];
  }

  if (DEBUG) {
    console.log('\n─── AI RESPONSE ───');
    console.log(rawText.slice(0, 2000));
    console.log('───────────────────\n');
  }

  try {
    const clean = rawText.replace(/```json\n?|```/g, '').trim();
    // Find the JSON array in the response
    const jsonStart = clean.indexOf('[');
    const jsonEnd   = clean.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON array found in response');
    return JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    console.error(`   ❌ Failed to parse AI response: ${e.message}`);
    if (DEBUG) console.error('   Raw:', rawText.slice(0, 500));
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
  if (PROVIDER === 'claude' && !CLAUDE_KEY) {
    console.error('❌ Claude provider selected but ANTHROPIC_API_KEY not set.');
    console.error('   Switch to Ollama: node self-heal.js --provider ollama');
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
      console.log('   Run with --debug to inspect.');
      break;
    }

    const patches = await healWithAI(lastResult.failures, featureFiles);
    if (patches.length === 0) {
      console.log('\n⚠️  AI generated no patches. Stopping.');
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

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
