import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KARATE_DIR = path.join(REPO_ROOT, 'karate-tests');
const SERVICE_DIR = path.join(REPO_ROOT, 'inventory-service');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const server = new Server(
  { name: 'sentinel-karate-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'run_karate_tests',
      description: 'Run Karate API tests. Optionally filter by tag or feature file.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Karate tag to filter (e.g. @smoke, @inventory)' },
          feature: { type: 'string', description: 'Specific feature file path relative to karate-tests/src/test/resources/' },
          env: { type: 'string', description: 'Environment: dev|qa|prod', default: 'dev' }
        }
      }
    },
    {
      name: 'get_test_results',
      description: 'Get the latest Karate test results and failure details',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'read_feature_file',
      description: 'Read the content of a Karate feature file',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path to feature file relative to karate-tests/src/test/resources/' }
        }
      }
    },
    {
      name: 'write_feature_file',
      description: 'Write/patch a Karate feature file (used by self-healing)',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Path to feature file relative to karate-tests/src/test/resources/' },
          content: { type: 'string', description: 'New content for the feature file' }
        }
      }
    },
    {
      name: 'list_feature_files',
      description: 'List all .feature files in the karate-tests directory',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'start_service',
      description: 'Start the inventory Spring Boot service',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'self_heal_failures',
      description: 'Analyze test failures and auto-patch feature files using Claude AI',
      inputSchema: {
        type: 'object',
        properties: {
          failures: { type: 'string', description: 'Paste the failure output from Karate tests' }
        }
      }
    },
    {
      name: 'run_and_heal',
      description: 'Run tests, detect failures, auto-patch with Claude, and re-run. Full self-healing loop.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Optional tag filter' },
          max_retries: { type: 'number', description: 'Max heal-and-retry cycles (default: 3)', default: 3 }
        }
      }
    }
  ]
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case 'run_karate_tests': {
        const env = args?.env || 'dev';
        let cmd = `cd "${KARATE_DIR}" && mvn test -Dkarate.env=${env}`;
        if (args?.tag) cmd += ` -Dkarate.options="--tags ${args.tag}"`;
        if (args?.feature) cmd += ` -Dtest=KarateTestRunner -Dkarate.options="${args.feature}"`;

        let output = '';
        let exitCode = 0;
        try {
          const result = await execAsync(cmd, { timeout: 120000 });
          output = result.stdout + result.stderr;
        } catch (err) {
          output = err.stdout + err.stderr;
          exitCode = err.code || 1;
        }

        const passed = (output.match(/Tests run: (\d+), Failures: 0/g) || []).length;
        const failures = extractFailures(output);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: exitCode === 0,
              exitCode,
              summary: extractSummary(output),
              failures,
              rawOutput: output.slice(-3000)
            }, null, 2)
          }]
        };
      }

      case 'get_test_results': {
        const reportDir = path.join(KARATE_DIR, 'target', 'surefire-reports');
        try {
          const files = await readdir(reportDir);
          const xmlFiles = files.filter(f => f.endsWith('.xml'));
          const results = [];
          for (const f of xmlFiles.slice(-5)) {
            const content = await readFile(path.join(reportDir, f), 'utf8');
            results.push({ file: f, content: content.slice(0, 2000) });
          }
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } catch {
          return { content: [{ type: 'text', text: 'No test results found. Run tests first.' }] };
        }
      }

      case 'read_feature_file': {
        const filePath = path.join(KARATE_DIR, 'src', 'test', 'resources', args.path);
        const content = await readFile(filePath, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      }

      case 'write_feature_file': {
        const filePath = path.join(KARATE_DIR, 'src', 'test', 'resources', args.path);
        await writeFile(filePath, args.content, 'utf8');
        return { content: [{ type: 'text', text: `Written: ${args.path}` }] };
      }

      case 'list_feature_files': {
        const featuresDir = path.join(KARATE_DIR, 'src', 'test', 'resources', 'karate');
        const files = await listFiles(featuresDir, '.feature');
        return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
      }

      case 'start_service': {
        const cmd = `cd "${SERVICE_DIR}" && mvn spring-boot:run &`;
        exec(cmd);
        await new Promise(r => setTimeout(r, 8000));
        try {
          const { stdout } = await execAsync('curl -s http://localhost:8090/api/products | head -c 100');
          return { content: [{ type: 'text', text: `Service started. Sample response: ${stdout}` }] };
        } catch {
          return { content: [{ type: 'text', text: 'Service starting... wait a few seconds and retry.' }] };
        }
      }

      case 'self_heal_failures': {
        const healResult = await selfHeal(args?.failures || '');
        return { content: [{ type: 'text', text: JSON.stringify(healResult, null, 2) }] };
      }

      case 'run_and_heal': {
        const maxRetries = args?.max_retries || 3;
        const tag = args?.tag;
        const log = [];

        for (let i = 0; i < maxRetries; i++) {
          log.push(`\n=== Run ${i + 1}/${maxRetries} ===`);

          // Run tests
          let cmd = `cd "${KARATE_DIR}" && mvn test -Dkarate.env=dev`;
          if (tag) cmd += ` -Dkarate.options="--tags ${tag}"`;

          let output = '';
          try {
            const result = await execAsync(cmd, { timeout: 120000 });
            output = result.stdout + result.stderr;
          } catch (err) {
            output = err.stdout + err.stderr;
          }

          const failures = extractFailures(output);
          const summary = extractSummary(output);
          log.push(`Summary: ${summary}`);

          if (failures.length === 0) {
            log.push('✅ All tests passed!');
            break;
          }

          log.push(`❌ ${failures.length} failures detected. Calling Claude to heal...`);
          const healResult = await selfHeal(failures.join('\n'));
          log.push(`Heal result: ${JSON.stringify(healResult)}`);
        }

        return { content: [{ type: 'text', text: log.join('\n') }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true
    };
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSummary(output) {
  const match = output.match(/Tests run: \d+.*?BUILD (SUCCESS|FAILURE)/s);
  return match ? match[0].split('\n').slice(-3).join(' ') : 'No summary found';
}

function extractFailures(output) {
  const failures = [];
  const lines = output.split('\n');
  let inFailure = false;
  let current = [];

  for (const line of lines) {
    if (line.includes('FAILED') || line.includes('AssertionError') || line.includes('did not match')) {
      inFailure = true;
      current = [line];
    } else if (inFailure) {
      current.push(line);
      if (current.length > 15 || line.trim() === '') {
        failures.push(current.join('\n'));
        inFailure = false;
        current = [];
      }
    }
  }
  return failures;
}

async function listFiles(dir, ext) {
  const result = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...await listFiles(full, ext));
      } else if (entry.name.endsWith(ext)) {
        result.push(full.replace(KARATE_DIR + '/src/test/resources/', ''));
      }
    }
  } catch {}
  return result;
}

async function selfHeal(failureOutput) {
  if (!ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY not set' };

  const featuresDir = path.join(KARATE_DIR, 'src', 'test', 'resources', 'karate');
  const featureFiles = await listFiles(featuresDir, '.feature');
  const featureContents = {};
  for (const f of featureFiles) {
    const fullPath = path.join(KARATE_DIR, 'src', 'test', 'resources', f);
    featureContents[f] = await readFile(fullPath, 'utf8');
  }

  const prompt = `You are a Karate API test self-healing agent.

Current feature files:
${Object.entries(featureContents).map(([f, c]) => `=== ${f} ===\n${c}`).join('\n\n')}

Test failure output:
${failureOutput}

Analyze the failures and return a JSON array of patches needed:
[
  {
    "file": "karate/inventory/products.feature",
    "reason": "Explanation of what was wrong",
    "patchedContent": "...full corrected feature file content..."
  }
]

Rules:
- Only patch what is actually broken based on the failure
- Keep all passing scenarios intact
- Fix assertion mismatches, wrong status codes, incorrect field names
- Return ONLY valid JSON array, no other text`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || '[]';
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const patches = JSON.parse(clean);
    const applied = [];
    for (const patch of patches) {
      if (patch.file && patch.patchedContent) {
        const fullPath = path.join(KARATE_DIR, 'src', 'test', 'resources', patch.file);
        await writeFile(fullPath, patch.patchedContent, 'utf8');
        applied.push({ file: patch.file, reason: patch.reason });
      }
    }
    return { patched: applied, count: applied.length };
  } catch (e) {
    return { error: 'Failed to parse Claude response', raw: clean };
  }
}

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Sentinel Karate MCP server running...');
