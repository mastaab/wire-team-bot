import { it, expect, vi } from "vitest";
import { OpenAIGeneralAnswerAdapter, integrationsPrompt } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { OpenAIQueryAnalysisAdapter } from "../../src/infrastructure/llm/OpenAIQueryAnalysisAdapter";

it("identifies the current requester separately from earlier participants in both model calls", async () => {
  const llm = { chatCompletion: vi.fn().mockResolvedValue({ content: "Bob owns the checklist.", model: "test", usedFallback: false }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const requester = { id: "bob", domain: "wire.test", name: "Bob" };
  const members = [{ id: "alice", domain: "wire.test", name: "Alice" }, requester];
  await new OpenAIGeneralAnswerAdapter(llm as never, logger).answer(
    "What am I responsible for?", ["Alice: I assigned Bob the checklist."], [], members, undefined, 0.5, requester,
  );
  const answerMessages = llm.chatCompletion.mock.calls[0][1];
  expect(answerMessages[0].content).toContain("Never infer the current speaker from earlier messages");
  expect(answerMessages[1].content).toContain(`## Current requester\n${JSON.stringify(requester)}`);
  llm.chatCompletion.mockResolvedValue({ content: "{}", model: "test", usedFallback: false });
  await new OpenAIQueryAnalysisAdapter(llm as never, logger).analyse("What am I responsible for?", { channelId: "channel@wire.test" }, members, requester);
  expect(llm.chatCompletion.mock.calls[1][1][1].content).toContain(`Current requester: ${JSON.stringify(requester)}`);
});

it("tells the answer model about the Jira integration only when it is configured", async () => {
  const llm = { chatCompletion: vi.fn().mockResolvedValue({ content: "Use `status of DS-4`.", model: "test", usedFallback: false }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const ask = (adapter: OpenAIGeneralAnswerAdapter) => adapter.answer("What is the status of DS-4?", [], [], [], undefined, 0.5);

  await ask(new OpenAIGeneralAnswerAdapter(llm as never, logger, { jiraProjectKey: "DS" }));
  const configured = llm.chatCompletion.mock.calls[0][1][0].content as string;
  expect(configured).toContain("connected to the Jira Service Management project DS");
  expect(configured).toContain("Never say that it has no Jira integration");
  expect(configured).toContain("`status of DS-NN`");
  expect(configured).toContain("`ACT-NNNN to jira`");
  expect(configured).toContain("`reply to DS-NN: <text>`");
  expect(configured).toContain("You cannot read or change Jira while writing this answer");
  expect(configured).toContain("do not describe internal mechanics");
  expect(configured).toContain("never state or guess a ticket's status in Jira");

  await ask(new OpenAIGeneralAnswerAdapter(llm as never, logger));
  expect(llm.chatCompletion.mock.calls[1][1][0].content).not.toContain("Jira");
  expect(integrationsPrompt({})).toBe("");
});
