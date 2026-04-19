'use strict';

const ai = require('./ai');

/**
 * Analyze text and return structured feedback.
 *
 * The AI is instructed to reply with a strict JSON object containing:
 *   - sentiment: "positive" | "negative" | "neutral"
 *   - topic: a short string describing the main topic
 *   - suggestions: an array of actionable improvement suggestions
 *
 * @param {string} text - The text to analyze.
 * @param {object} [aiOptions] - Options forwarded to ai.ask().
 * @returns {Promise<{sentiment: string, topic: string, suggestions: string[]}>}
 */
async function analyze(text, aiOptions = {}) {
  const prompt = [
    'You are a text analysis assistant. Analyze the following text and respond with ONLY a valid JSON object.',
    'The JSON must have exactly these fields:',
    '  "sentiment": one of "positive", "negative", or "neutral"',
    '  "topic": a short phrase (5 words or fewer) describing the main topic',
    '  "suggestions": an array of 1–3 concise, actionable improvement suggestions',
    '',
    'Do not include any explanation or text outside the JSON object.',
    '',
    'Text to analyze:',
    text,
  ].join('\n');

  const raw = await ai.ask(prompt, aiOptions);

  return parseAnalysis(raw);
}

/**
 * Parse the AI response into a structured object.
 * Falls back to a default structure if parsing fails.
 *
 * @param {string} raw - Raw string from the AI.
 * @returns {{sentiment: string, topic: string, suggestions: string[]}}
 */
function parseAnalysis(raw) {
  // Extract the first JSON object found in the response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return buildFallback('Could not extract JSON from AI response.');
  }

  try {
    const parsed = JSON.parse(match[0]);

    const sentiment = normalizeSentiment(parsed.sentiment);
    const topic = typeof parsed.topic === 'string' ? parsed.topic.trim() : 'Unknown';
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s) => String(s).trim()).filter(Boolean)
      : ['No suggestions available.'];

    return { sentiment, topic, suggestions };
  } catch {
    return buildFallback('Failed to parse AI JSON response.');
  }
}

/**
 * Normalize sentiment value to one of the accepted values.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeSentiment(value) {
  const allowed = ['positive', 'negative', 'neutral'];
  const lower = typeof value === 'string' ? value.toLowerCase().trim() : '';
  return allowed.includes(lower) ? lower : 'neutral';
}

/**
 * Build a safe fallback response.
 *
 * @param {string} reason
 * @returns {{sentiment: string, topic: string, suggestions: string[]}}
 */
function buildFallback(reason) {
  return {
    sentiment: 'neutral',
    topic: 'Unknown',
    suggestions: [reason],
  };
}

module.exports = { analyze };
