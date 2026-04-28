import { generateObject as _generateObject, generateText as _generateText } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModelV2 } from "@ai-sdk/provider";

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

function resolveModel(model: unknown) {
  if (typeof model === "string") return gateway(model) as unknown as LanguageModelV2;
  return model;
}

export const generateText: typeof _generateText = ((params: any) => {
  return _generateText({ ...params, model: resolveModel(params.model) });
}) as typeof _generateText;

export const generateObject: typeof _generateObject = ((params: any) => {
  return _generateObject({ ...params, model: resolveModel(params.model) });
}) as typeof _generateObject;
