const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;

function getClient() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

/**
 * Analyze a GitHub issue or PR using Gemini.
 * Returns: { summary, suggestedLabel, priority, reasoning }
 */
async function analyzeIssueOrPR({ title, body, eventType, repoFullName }) {
  const client = getClient();
  if (!client) {
    return null; // Gemini not configured, skip gracefully
  }

  try {
    const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `You are a GitHub issue triage bot. Analyze the following GitHub ${eventType} and respond with a JSON object.

Repository: ${repoFullName}
Title: ${title}
Body:
${(body || '').slice(0, 2000)}

Respond with ONLY valid JSON in this exact format:
{
  "summary": "1-2 sentence summary of the issue/PR",
  "suggestedLabel": "one of: bug, enhancement, documentation, question, security, performance, breaking-change, good first issue",
  "priority": "one of: critical, high, medium, low",
  "reasoning": "1 sentence explaining the priority"
}

Guidelines:
- critical = security vulnerabilities, data loss, production outages
- high = breaking functionality, significant regressions  
- medium = bugs with workarounds, feature requests
- low = docs, minor improvements, questions
- For pull_request eventType, focus on the change's impact and risk`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Gemini response');

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate expected fields exist
    if (!parsed.summary || !parsed.suggestedLabel || !parsed.priority) {
      throw new Error('Missing required fields in Gemini response');
    }

    return parsed;
  } catch (err) {
    console.error('[AI] Gemini analysis failed:', err.message);
    return null; // Degrade gracefully, don't fail the whole pipeline
  }
}

/**
 * Analyze a push event to summarize commits.
 */
async function analyzePush({ commits, repoFullName, branch }) {
  const client = getClient();
  if (!client || !commits?.length) return null;

  try {
    const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const commitList = commits
      .slice(0, 10)
      .map(c => `- ${c.message?.split('\n')[0]}`)
      .join('\n');

    const prompt = `Summarize these git commits for the ${branch} branch of ${repoFullName} in 1-2 sentences. Focus on what changed, not how.

Commits:
${commitList}

Respond with ONLY the summary text (no JSON, no markdown).`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[AI] Push analysis failed:', err.message);
    return null;
  }
}

module.exports = { analyzeIssueOrPR, analyzePush };
