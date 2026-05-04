const fs = require('fs');
const path = require('path');

function readFromEnvFile() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const result = {};
  const openaiMatch = content.match(/OPENAI_API_KEY=(.+)/);
  if (openaiMatch) result.openai = openaiMatch[1].trim();
  const anthropicMatch = content.match(/ANTHROPIC_API_KEY=(.+)/);
  if (anthropicMatch) result.anthropic = anthropicMatch[1].trim();
  return result;
}

try {
  let openaiKey = process.env.OPENAI_API_KEY;
  let anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!openaiKey || !anthropicKey) {
    const fileKeys = readFromEnvFile();
    openaiKey = openaiKey || fileKeys.openai;
    anthropicKey = anthropicKey || fileKeys.anthropic;
  }

  if (!openaiKey) throw new Error("OPENAI_API_KEY not found in environment or .env.local");

  const authProfilePath = path.join(require('os').homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
  fs.mkdirSync(path.dirname(authProfilePath), { recursive: true });

  fs.writeFileSync(authProfilePath, JSON.stringify({
    openai: {
      primary: {
        method: "apiKey",
        value: openaiKey
      }
    },
    ...(anthropicKey && {
      anthropic: {
        primary: {
          method: "apiKey",
          value: anthropicKey
        }
      }
    })
  }, null, 2));

  console.log("Successfully synced API key to openclaw");
} catch(e) {
  console.error("Failed to sync key:", e);
}
