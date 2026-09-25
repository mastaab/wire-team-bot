import { describe, it, expect, vi } from "vitest";
import { OpenAIGeneralAnswerAdapter, integrationsPrompt } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";
import type { AnswerIntegrations } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import { parseOfferMarker } from "../../src/application/services/offers";

const date = new Date("2026-09-25T10:00:00Z");

function result(id: string, type: RetrievalResult["type"], content: string): RetrievalResult {
  return { id, type, content, sourceChannel: "conv-1@wire.com", sourceDate: date, confidence: 1, pathsMatched: ["test"] };
}

function setup(content: string | string[], integrations: AnswerIntegrations = { jiraProjectKey: "DS" }) {
  const replies = Array.isArray(content) ? content : [content];
  const llm = { chatCompletion: vi.fn() };
  for (const reply of replies) llm.chatCompletion.mockResolvedValueOnce({ content: reply, model: "test", usedFallback: false });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const adapter = new OpenAIGeneralAnswerAdapter(llm as never, logger, integrations);
  return { llm, adapter };
}

describe("integrationsPrompt", () => {
  it("is empty without Jira", () => {
    expect(integrationsPrompt({})).toBe("");
    expect(integrationsPrompt({ jiraShareWithModel: true })).toBe("");
  });

  it("keeps the read-only wording and adds offers when Jira is on without sharing", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "DS" });
    expect(prompt).toContain("connected to the Jira Service Management project DS");
    expect(prompt).toContain("Never say that it has no Jira integration");
    expect(prompt).toContain("You cannot read or change Jira while writing this answer");
    expect(prompt).toContain("never state or guess a ticket's status in Jira");
    expect(prompt).toContain("`ACT-NNNN to jira`");
    expect(prompt).toContain("`status of DS-NN`");
    expect(prompt).toContain("`ACT-NNNN done`");
    expect(prompt).toContain("Tickets are raised from actions");
    expect(prompt).toContain("do not describe internal mechanics");
    expect(prompt).not.toContain("## Linked Jira tickets");
    expect(prompt).toContain('OFFER: {"kind":"raise","actionId":"ACT-NNNN"}');
    expect(prompt).toContain('OFFER: {"kind":"close","actionId":"ACT-NNNN"}');
    expect(prompt).toContain('OFFER: {"kind":"reply","issueKey":"DS-NN","body":');
    expect(prompt).toContain('Do not ask "Shall I" yourself');
    expect(prompt).toContain("If the target record is unclear, ask which record is meant and add no marker");
  });

  it("describes the linked tickets section instead of the cannot-read line when sharing is on", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "DS", jiraShareWithModel: true });
    expect(prompt).not.toContain("You cannot read or change Jira while writing this answer");
    expect(prompt).toContain('A "## Linked Jira tickets" section, when present, holds the live status, SLAs and latest service-desk replies');
    expect(prompt).toContain("cite the ticket key");
    expect(prompt).toContain("Say nothing about a ticket beyond what that section states");
    expect(prompt).toContain("give the status command");
    expect(prompt).toContain("never guess a ticket's status");
    expect(prompt).toContain("Never say that it has no Jira integration");
    expect(prompt).toContain("`ACT-NNNN to jira`");
    expect(prompt).toContain("Tickets are raised from actions");
    expect(prompt).toContain('OFFER: {"kind":"raise","actionId":"ACT-NNNN"}');
  });

  it("uses the configured project key in the offer format", () => {
    expect(integrationsPrompt({ jiraProjectKey: "OPS" })).toContain('"issueKey":"OPS-NN"');
  });
});

describe("OpenAIGeneralAnswerAdapter with Jira tickets and offers", () => {
  it("renders ticket results under their own section and not under Related Context", async () => {
    const { llm, adapter } = setup("DS-4 is in progress.", { jiraProjectKey: "DS", jiraShareWithModel: true });
    await adapter.answer("Latest on DS-4?", [], [
      result("ACT-0010", "action", "ACT-0010 | Write the proposal | Jira: DS-4"),
      result("DS-4", "jira_ticket", "DS-4: Proposal\nStatus: In progress"),
      result("E1", "entity", "Proposal relates to Acme"),
    ], [], undefined, 0.5);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(system).toContain("## Linked Jira tickets");
    expect(user).toContain("## Linked Jira tickets\n- DS-4: Proposal\nStatus: In progress\n\n");
    const related = user.slice(user.indexOf("## Related Context"));
    expect(related).toContain("- Proposal relates to Acme");
    expect(related).not.toContain("DS-4: Proposal");
    expect(user.indexOf("## Relevant Actions")).toBeLessThan(user.indexOf("## Linked Jira tickets"));
  });

  it("omits the ticket section when there are no ticket results", async () => {
    const { llm, adapter } = setup("Nothing yet.");
    await adapter.answer("Anything?", [], [result("E1", "entity", "Something")], [], undefined, 0.5);
    expect(llm.chatCompletion.mock.calls[0][1][1].content).not.toContain("## Linked Jira tickets");
  });

  it("keeps a final marker line intact after text", async () => {
    const answer = 'ACT-0010 has no ticket yet.\nOFFER: {"kind":"raise","actionId":"ACT-0010"}';
    const { llm, adapter } = setup(answer);
    const returned = await adapter.answer("Put the proposal in Jira", [], [], [], undefined, 0.5);
    expect(returned).toBe(answer);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "raise", actionId: "ACT-0010" });
  });

  it("keeps a reply marker whose body contains sentences and a question", async () => {
    const answer = 'Here is the reply.\nOFFER: {"kind":"reply","issueKey":"DS-4","body":"Thanks. Can you send the draft?"}';
    const { adapter } = setup(answer);
    const returned = await adapter.answer("Reply to DS-4", [], [], [], undefined, 0.5);
    expect(parseOfferMarker(returned)).toEqual({ text: "Here is the reply.", command: { kind: "reply", issueKey: "DS-4", body: "Thanks. Can you send the draft?" } });
  });

  it("strips a model-written offer question before the marker without losing the marker", async () => {
    const { llm, adapter } = setup('- ACT-0010 Write the proposal\n\nIt has no ticket yet. Shall I raise it in Jira?\nOFFER: {"kind":"raise","actionId":"ACT-0010"}');
    const returned = await adapter.answer("Put the proposal in Jira", [], [], [], undefined, 0.5);
    expect(returned).toBe('- ACT-0010 Write the proposal\n\nIt has no ticket yet.\nOFFER: {"kind":"raise","actionId":"ACT-0010"}');
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns the marker alone instead of retrying when the only text is an offer question", async () => {
    const { llm, adapter } = setup('Shall I raise ACT-0010 in Jira?\nOFFER: {"kind":"raise","actionId":"ACT-0010"}');
    const returned = await adapter.answer("Put the proposal in Jira", [], [], [], undefined, 0.5);
    expect(returned).toBe('OFFER: {"kind":"raise","actionId":"ACT-0010"}');
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps the marker from the retry answer", async () => {
    const { llm, adapter } = setup(["Shall I check?", 'Here it is.\nOFFER: {"kind":"close","actionId":"ACT-0010"}']);
    const returned = await adapter.answer("Close the proposal", [], [], [], undefined, 0.5);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(2);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "close", actionId: "ACT-0010" });
  });
});
