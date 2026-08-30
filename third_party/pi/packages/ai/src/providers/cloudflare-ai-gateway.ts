import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

export function cloudflareAIGatewayProvider(): Provider<
	"anthropic-messages" | "openai-completions" | "openai-responses"
> {
	// 显式类型参数：flattenModelCatalog 的 const 泛型对 JSON import 会把 api 联合
	// 收窄为 models 数据里实际出现的两项（丢 openai-completions），显式钉住三键
	// 后 api 记录与返回类型 Provider<三键> 一致，excess property check 不再触发。
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			["openai-completions" as const]: cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
