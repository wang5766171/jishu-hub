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
		// v0.9.2 测试期修复：描述泛化到全部会话场景（原 "during task execution"
		// 过窄，普通会话模型不认为该工具可用于问答/测验/澄清）。
		description:
			"Ask the user a structured question mid-turn: an interactive card with options (single or multi select) or a free-text field. The agent pauses until the user responds, then continues the same turn with the answer. Use it whenever the user should choose or provide input — requirement clarification, confirmations, quizzes and interactive games, walking through alternatives. When the user asks for interactive/structured questioning (e.g. 交互模式), ALWAYS use this tool instead of listing options in plain text.",
		promptSnippet:
			"request_user_input: Interactive card to ask the user a question or offer choices; prefer it over plain-text option lists",
		parameters: Type.Object({
			question: Type.String({
				description: "The question to ask the user",
			}),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Available choices. Omit for free-text input.",
				}),
			),
			multi: Type.Optional(
				Type.Boolean({
					description:
						"Set to true to allow the user to select multiple options (checkbox-style). Default false (single-select).",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { question, options, multi } = params as {
				question: string;
				options?: string[];
				multi?: boolean;
			};
			let response: string | undefined;

			if (options && options.length > 0) {
				if (multi) {
					const selected = await ctx.ui.multiSelect(question, options);
					response = selected ? selected.join(", ") : undefined;
				} else {
					response = await ctx.ui.select(question, options);
				}
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
