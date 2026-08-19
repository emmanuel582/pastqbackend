require('dotenv').config();
const groq = require('../services/vision/groq');
const { PROVIDER, MODELS } = require('../services/vision/models');

async function main() {
  console.log('Provider:', PROVIDER);
  console.log('Models:', MODELS);

  const chat = await groq.chatJson(
    'You return JSON only.',
    'Return {"ok":true,"test":"groq-reasoning"}',
    { model: MODELS.cheap, maxTokens: 256 }
  );
  console.log('Cheap model response:', chat.content);

  const strong = await groq.chatJson(
    'You return JSON only.',
    'Return {"ok":true,"test":"groq-strong"}',
    { model: MODELS.strong, maxTokens: 256 }
  );
  console.log('Strong model response:', strong.content);

  console.log('Groq integration OK');
}

main().catch((err) => {
  console.error('Groq test failed:', err.message);
  process.exit(1);
});
