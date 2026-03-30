import { generateText as _generateText, generateObject as _generateObject } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModelV2 } from "@ai-sdk/provider";

const GATEWAY_FALLBACK_MODEL = "openai/gpt-5.4-mini";
const GEMINI_RETRY_DELAY_MS = 5_000;

function isGeminiModelId(modelId: string): boolean {
  return modelId.includes("gemini");
}

function isGatewayTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const name = (error as any).name ?? "";
  const message = (error as any).message ?? "";
  const causeName = (error as any).cause?.name;
  const causeStatusCode = (error as any).cause?.statusCode;

  if (causeStatusCode && [502, 503, 504].includes(causeStatusCode)) return true;

  return (
    name === "GatewayResponseError" ||
    name === "GatewayTimeoutError" ||
    name === "AbortError" ||
    causeName === "AbortError" ||
    message.includes("Gateway request failed") ||
    message.includes("Gateway request timed out") ||
    message.includes("This operation was aborted") ||
    message.includes("fetch failed") ||
    message.includes("ECONNRESET") ||
    /50[0-3]/.test(String((error as any).status ?? ""))
  );
}

function patchGatewayUsage(result: any): any {
  const u = result?.usage;
  if (!u) return result;
  if (typeof u.inputTokens !== "object" || !u.inputTokens)
    u.inputTokens = { total: u.inputTokens ?? 0 };
  if (typeof u.outputTokens !== "object" || !u.outputTokens)
    u.outputTokens = { total: u.outputTokens ?? 0 };
  return result;
}

function withGatewayFallback(
  primaryModel: LanguageModelV2,
  modelId: string,
  gatewayFactory: () => ReturnType<typeof createGateway>,
): LanguageModelV2 {
  const isGemini = isGeminiModelId(modelId);

  function fallbackModel(): LanguageModelV2 {
    const gw = gatewayFactory();
    return gw(GATEWAY_FALLBACK_MODEL) as unknown as LanguageModelV2;
  }

  async function callWithFallback(mode: string, options: any): Promise<any> {
    const call = (model: LanguageModelV2): PromiseLike<any> =>
      mode === "doGenerate" ? model.doGenerate(options) : model.doStream(options);

    try {
      const result = await call(primaryModel);
      return mode === "doGenerate" ? patchGatewayUsage(result) : result;
    } catch (error) {
      if (!isGatewayTransientError(error)) throw error;

      // Gemini: extra delayed retry with the same model before falling back
      if (isGemini) {
        console.warn(`[ai] ${modelId}: retrying after ${GEMINI_RETRY_DELAY_MS}ms cooldown (${mode})`);
        await new Promise((r) => setTimeout(r, GEMINI_RETRY_DELAY_MS));

        try {
          const result = await call(primaryModel);
          console.info(`[ai] ${modelId}: recovered via delayed retry (${mode})`);
          return mode === "doGenerate" ? patchGatewayUsage(result) : result;
        } catch (retryError) {
          console.warn(`[ai] ${modelId}: delayed retry failed, falling back to ${GATEWAY_FALLBACK_MODEL} (${mode})`);
        }
      } else {
        console.warn(`[ai] ${modelId}: gateway failed (${(error as Error).message}), falling back to ${GATEWAY_FALLBACK_MODEL} (${mode})`);
      }

      // Fallback to cheap model
      try {
        const result = await call(fallbackModel());
        console.info(`[ai] ${modelId}: recovered via fallback model ${GATEWAY_FALLBACK_MODEL} (${mode})`);
        return result;
      } catch (fallbackError) {
        console.error(`[ai] ${modelId}: fallback to ${GATEWAY_FALLBACK_MODEL} also failed (${mode}), giving up`);
        throw error;
      }
    }
  }

  return {
    ...primaryModel,
    async doGenerate(options) {
      return callWithFallback("doGenerate", options);
    },
    async doStream(options) {
      return callWithFallback("doStream", options);
    },
  };
}

function createAIGateway() {
  const makeGateway = () =>
    createGateway({
      apiKey: process.env.AI_GATEWAY_API_KEY,
    });

  const gateway = makeGateway();

  const wrappedGateway = (modelId: string, ...args: unknown[]) => {
    const primaryModel = (gateway as Function)(modelId, ...args);
    return withGatewayFallback(
      primaryModel as LanguageModelV2,
      modelId,
      makeGateway,
    );
  };

  return Object.assign(wrappedGateway, gateway) as unknown as ReturnType<typeof createGateway>;
}

const gateway = createAIGateway();

function resolveModel(model: unknown) {
  if (typeof model === "string") return gateway(model);
  return model;
}

export const generateText: typeof _generateText = ((params: any) => {
  return _generateText({ ...params, model: resolveModel(params.model) });
}) as typeof _generateText;

export const generateObject: typeof _generateObject = ((params: any) => {
  return _generateObject({ ...params, model: resolveModel(params.model) });
}) as typeof _generateObject;
