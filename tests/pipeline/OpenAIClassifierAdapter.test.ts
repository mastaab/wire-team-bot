import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { OpenAIClassifierAdapter } from "../../src/infrastructure/llm/OpenAIClassifierAdapter";
import type { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
import type { Logger } from "../../src/application/ports/Logger";

const logger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeLLM(content: string): LLMClientFactory {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content, model: "test-model", usedFallback: false }),
  } as unknown as LLMClientFactory;
}

const ctx = { channelId: "ch1" };

describe("OpenAIClassifierAdapter", () => {
  it("parses a high-signal decision result", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["decision"],
      confidence: 0.9,
      entities: ["Postgres"],
      is_high_signal: true,
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("We decided to use Postgres", ctx, []);
    expect(result.categories).toContain("decision");
    expect(result.is_high_signal).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.entities).toContain("Postgres");
  });

  it("parses a low-signal discussion result", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["discussion"],
      confidence: 0.7,
      entities: [],
      is_high_signal: false,
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("Sounds good to me", ctx, []);
    expect(result.is_high_signal).toBe(false);
    expect(result.categories).toContain("discussion");
  });

  it("infers is_high_signal from categories when LLM omits it", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["action", "update"],
      confidence: 0.85,
      entities: ["Alice"],
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("Alice will review the PR by Friday", ctx, []);
    expect(result.is_high_signal).toBe(true);
  });

  it("falls back on LLM error", async () => {
    const llm = {
      chatCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as LLMClientFactory;
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("some text", ctx, []);
    expect(result.categories).toContain("discussion");
    expect(result.is_high_signal).toBe(false);
  });

  it("falls back on malformed JSON", async () => {
    const llm = makeLLM("not json at all");
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("some text", ctx, []);
    expect(result.categories).toContain("discussion");
    expect(result.is_high_signal).toBe(false);
  });

  it("filters invalid category values", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["decision", "INVALID_CAT", "action"],
      confidence: 0.8,
      entities: [],
      is_high_signal: true,
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("We decided and Alice will act", ctx, []);
    expect(result.categories).toEqual(["decision", "action"]);
  });

  it("strips ```json markdown wrappers", async () => {
    const llm = makeLLM(
      "```json\n" + JSON.stringify({ categories: ["blocker"], confidence: 0.8, entities: [], is_high_signal: true }) + "\n```"
    );
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("build is broken", ctx, []);
    expect(result.categories).toContain("blocker");
    expect(result.is_high_signal).toBe(true);
  });
});
it("routes completion updates to extraction even if the model marks them low signal", async () => {
  const adapter=new OpenAIClassifierAdapter(makeLLM(JSON.stringify({categories:["update"],confidence:0.9,is_high_signal:false})),logger);
  expect((await adapter.classify("I've sent the NDA",ctx,[])).is_high_signal).toBe(true);
});

describe("OpenAIClassifierAdapter service-desk categories", () => {
  const fullCtx = { channelId: "ch1", purpose: "Support", contextType: "team" };
  const sentMessages = (llm: LLMClientFactory) => (llm.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];

  it("sends a byte-for-byte unchanged request when the option is off", async () => {
    for (const options of [undefined, {}, { serviceDeskCategories: false }]) {
      const llm = makeLLM("{}");
      await new OpenAIClassifierAdapter(llm, logger, options).classify("Printer is broken", fullCtx, ["[Alice] hi"]);
      // SHA-256 of the request recorded before the option existed.
      expect(createHash("sha256").update(JSON.stringify(sentMessages(llm))).digest("hex"))
        .toBe("70202e54b1ca95c6fd1e2710b1ec2247966e83ea7f5d34782a4d0596b362ebc5");
    }
  });

  it("rejects the service-desk categories when the option is off", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["service_request", "request_status"], confidence: 0.9, entities: [], is_high_signal: false }));
    const result = await new OpenAIClassifierAdapter(llm, logger).classify("Printer is broken", ctx, []);
    expect(result.categories).toEqual(["discussion"]);
  });

  it("offers and accepts the service-desk categories when the option is on", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["service_request", "request_status", "question"], confidence: 0.9, entities: [], is_high_signal: false }));
    const result = await new OpenAIClassifierAdapter(llm, logger, { serviceDeskCategories: true }).classify("Printer is broken, any news on DS-6?", ctx, []);
    expect(result.categories).toEqual(["service_request", "request_status", "question"]);
    const system = sentMessages(llm)[1][0].content as string;
    expect(system).toContain("- service_request: ");
    expect(system).toContain("or adds information to a problem already reported");
    expect(system).toContain("- request_status: ");
    expect(system).toContain("service_request and request_status never make a message high signal on their own.");
    expect(system).toContain("They come in addition to every other category that applies");
  });

  it("keeps the rest of the prompt when the option is on", async () => {
    const off = makeLLM("{}");
    const on = makeLLM("{}");
    await new OpenAIClassifierAdapter(off, logger).classify("x", ctx, []);
    await new OpenAIClassifierAdapter(on, logger, { serviceDeskCategories: true }).classify("x", ctx, []);
    const offPrompt = sentMessages(off)[1][0].content as string;
    const onPrompt = sentMessages(on)[1][0].content as string;
    const added = onPrompt.split("\n").filter((line) => !offPrompt.split("\n").includes(line));
    expect(added).toHaveLength(3);
    expect(onPrompt.split("\n").filter((line) => !added.includes(line)).join("\n")).toBe(offPrompt);
  });

  it("never makes a service-desk category alone high signal", async () => {
    for (const categories of [["service_request"], ["request_status"], ["service_request", "question", "discussion"]]) {
      const llm = makeLLM(JSON.stringify({ categories, confidence: 0.95, entities: [], is_high_signal: true }));
      const result = await new OpenAIClassifierAdapter(llm, logger, { serviceDeskCategories: true }).classify("Printer is broken", ctx, []);
      expect(result.is_high_signal).toBe(false);
    }
  });

  it("keeps high signal from the other categories alongside a service-desk category", async () => {
    const llm = makeLLM(JSON.stringify({ categories: ["service_request", "blocker"], confidence: 0.9, entities: [], is_high_signal: true }));
    const result = await new OpenAIClassifierAdapter(llm, logger, { serviceDeskCategories: true }).classify("The build server is down and blocks the release", ctx, []);
    expect(result.is_high_signal).toBe(true);
  });
});
