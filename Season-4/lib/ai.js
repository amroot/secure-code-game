// ⚠️ Do not edit — this file is part of the ProdBot engine. In the real world, the assistant's internals are managed by its vendor.
/**
 * ai.js — AI interaction layer for ProdBot.
 *
 * This module handles communication with an OpenAI-compatible chat completions API.
 * By default that is a model running locally in your Codespace via Ollama, but any
 * compatible endpoint works — see Season-4/README.md.
 * It sends the user's natural language input to an LLM along with a system prompt
 * that instructs the model to respond with structured JSON containing bash commands.
 *
 * How it works:
 *   1. The SYSTEM_PROMPT tells the LLM it is "ProdBot" and defines two response formats:
 *      - { action: "bash", commands: [...] } — for tasks that need bash execution
 *      - { action: "message", text: "..." } — for conversational replies
 *   2. The user's message is sent as the "user" role in the chat
 *   3. The LLM's response is parsed as JSON; if parsing fails, it's treated as a message
 *
 * Key concepts demonstrated:
 *   - System prompts: constraining LLM output format via instructions
 *   - Structured output: getting reliable JSON from an LLM (with fallback)
 *   - API authentication: supplying an API key from the environment, never from source
 */

import OpenAI from "openai";
import chalk from "chalk";

// Set by .devcontainer/devcontainer.json. A local Ollama server ignores the key, but
// the OpenAI client still requires the field to be present.
const baseURL = process.env["SCG_AI_BASE_URL"];
const apiKey = process.env["SCG_AI_API_KEY"];
const model = process.env["SCG_AI_MODEL"] || "qwen2.5:7b";

/**
 * System prompt — this is the instruction set sent to the LLM before every request.
 * It defines ProdBot's persona, response format, and safety rules.
 * The LLM sees this as context but users never see it directly.
 */
const SYSTEM_PROMPT = `You are ProdBot, a productivity assistant that helps users via bash commands.
You operate inside a sandboxed directory. All commands run with that directory as the working directory.

When the user asks you to perform a task, respond with ONLY a JSON object (no markdown, no code fences) in one of these formats:

For executing bash commands:
{"action":"bash","commands":["command1","command2"]}

If the user's request is not a task (e.g. a question or greeting), respond with:
{"action":"message","text":"<your reply>"}

Rules:
- Use ONLY relative paths (e.g. "hello.txt", "src/app.js")
- Do NOT use absolute paths or path traversal (..)
- Each command in the array is executed sequentially
- Use standard bash commands: touch, mkdir, mv, cp, cat, echo, ls, etc.
- For creating files with content, use: echo "content" > file.txt
- For appending: echo "content" >> file.txt
- For multi-line files, use heredocs or multiple echo commands
- Keep commands simple and safe
- Always respond with valid JSON only, no other text`;

/**
 * Sends a user message to the LLM and returns a parsed action object.
 *
 * The OpenAI client is pointed at whatever endpoint SCG_AI_BASE_URL names, running
 * whatever model SCG_AI_MODEL names — by default a small, fast model suitable for
 * structured command generation.
 *
 * @param {string} userMessage - The user's natural language input
 * @param {string} [customSystemPrompt] - Optional custom system prompt (for agent-specific personas)
 * @returns {Promise<{ action: string, [key: string]: any }>} Parsed AI response
 */
export async function sendToAI(userMessage, customSystemPrompt) {
    if (!baseURL || !apiKey) {
        console.error(chalk.redBright(
            "❌ AI provider not configured. Set SCG_AI_BASE_URL and SCG_AI_API_KEY " +
            "(and optionally SCG_AI_MODEL) in your environment. See Season-4/README.md."
        ));
        return { action: "message", text: "Error: AI provider not configured." };
    }

    const openai = new OpenAI({ baseURL, apiKey });

    try {
        const completion = await openai.chat.completions.create({
            model,
            messages: [
                { role: "system", content: customSystemPrompt || SYSTEM_PROMPT },
                { role: "user", content: userMessage },
            ],
        });

        const raw = completion.choices[0].message?.content || "";

        // Try to parse the response as JSON.
        // If the LLM didn't follow the format, fall back to a plain message.
        try {
            return JSON.parse(raw);
        } catch {
            return { action: "message", text: raw };
        }
    } catch (err) {
        console.error(chalk.redBright(`❌ AI Error: ${describeAiError(err)}`));
        return { action: "message", text: "Sorry, I couldn't process that request." };
    }
}

// Turns a provider failure into something a player can act on. Never prints the key.
function describeAiError(err) {
    const status = err?.status;
    const code = err?.code ?? err?.error?.code ?? "";
    // Hosted models may refuse prompt-injection outright: Azure OpenAI reports
    // content_filter, serverless models report content_safety_violation.
    if (code === "content_filter" || code === "content_safety_violation" || /Jailbreak/i.test(err?.message ?? "")) {
        return "the provider's safety filter blocked this prompt. Some hosted models refuse prompt-injection attempts outright; try a different phrasing, or a different model.";
    }
    if (status === 401 || status === 403) return "the API key was rejected. Check SCG_AI_API_KEY.";
    if (status === 404) return `no model named "${model}" at ${baseURL}. Check SCG_AI_MODEL matches a model you have pulled — run: ollama list`;
    if (status === 429) return "the AI provider is rate limiting us. Wait a moment, then try again.";
    if (!status) return `could not reach the AI provider at ${baseURL}. Is it running? Try: ollama serve`;
    return `${status} ${err?.message ?? err}`;
}
