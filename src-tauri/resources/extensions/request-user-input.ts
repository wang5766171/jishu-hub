/**
 * `request_user_input` — a tool that lets the LLM ask the user a structured
 * question mid-turn (multiple-choice via `options`, or free-text). It pauses
 * the agent loop until the user responds, then resumes the same turn with the
 * answer.
 *
 * This file is the source of truth for the extension, owned by the jishu-hub
 * main repo (not the pi submodule). The Hub embeds it at compile time
 * (`include_str!` in `src-tauri/src/task_plan.rs`) and the setup hook deploys
 * it to the global extensions dir (`~/.jishu-agent/extensions/`) so the tool is
 * available in every project — same mechanism as `jishu-task-conductor`.
 *
 * Registration passes a plain object to `pi.registerTool` (NOT wrapped in
 * `defineTool`). `defineTool` is a type-only cast helper exported from
 * `@earendil-works/pi-coding-agent`; importing it as a VALUE would make this
 * extension require `@earendil-works/pi-coding-agent` at runtime, which pi's
 * Node-mode loader (getAliases) resolves to a non-existent path under the built
 * pi-bundle (`packages/index.js`) and fails to load. Importing only the TYPE
 * (`type ExtensionAPI`) keeps that require erased at runtime; `Type` comes from
 * `typebox`, a real dependency present in node_modules. See
 * `third_party/pi/docs/development-note.md` for full context.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function requestUserInputExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "request_user_input",
		label: "Request User Input",
		description:
			"Request structured input from the user during task execution. Use when you need the user to choose between options or provide information before continuing. The agent will pause until the user responds.",
		promptSnippet: "request_user_input: Ask the user a question or offer choices",
		parameters: Type.Object({
			question: Type.String({
				description: "The question to ask the user",
			}),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Available choices. Omit for free-text input.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { question, options } = params as { question: string; options?: string[] };
			let response: string | undefined;

			if (options && options.length > 0) {
				response = await ctx.ui.select(question, options);
			} else {
				response = await ctx.ui.input(question);
			}

			return {
				content: [{ type: "text" as const, text: response ?? "(no response)" }],
				details: undefined,
			};
		},
	});
}
