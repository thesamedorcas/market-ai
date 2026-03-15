const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '.env.local');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/OPENAI_API_KEY=(.+)/);
  if (!match) throw new Error("OPENAI_API_KEY not found in .env.local");
  
  const key = match[1].trim();
  const authProfilePath = path.join(require('os').homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
  
  fs.mkdirSync(path.dirname(authProfilePath), { recursive: true });
  fs.writeFileSync(authProfilePath, JSON.stringify({
    openai: {
      primary: {
        method: "apiKey",
        value: key
      }
    }
  }, null, 2));
  
  console.log("Successfully synced API key to openclaw");
} catch(e) {
  console.error("Failed to sync key:", e);
}
