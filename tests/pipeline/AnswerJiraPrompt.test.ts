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

const support = 'OFFER: {"kind":"support","summary":"VPN drops","description":"My VPN drops every ten minutes."}';

describe("integrationsPrompt", () => {
  it("is empty without Jira", () => {
    expect(integrationsPrompt({})).toBe("");
    expect(integrationsPrompt({ jiraShareWithModel: true })).toBe("");
  });

  it("lists the support request commands and offer kinds when Jira is on without sharing", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "DS" });
    expect(prompt).toContain("connected to the Jira Service Management project DS");
    expect(prompt).toContain("Never say that it has no Jira integration");
    expect(prompt).toContain("You cannot read or change Jira while writing this answer, and you have no ticket content");
    expect(prompt).toContain("never state or guess a ticket's live status in Jira");
    expect(prompt).toContain('A "## Support requests" section');
    expect(prompt).toContain("`@Wire Team Bot support: <problem>`");
    expect(prompt).toContain("`@Wire Team Bot support requests`");
    expect(prompt).toContain("`@Wire Team Bot my support requests`");
    expect(prompt).toContain("`@Wire Team Bot status of DS-NN`");
    expect(prompt).toContain("If the message is about something else or withdraws the offer, add no marker.");
    expect(prompt).toContain("`@Wire Team Bot reply to DS-NN: <text>`");
    expect(prompt).toContain("`@Wire Team Bot resolve DS-NN`");
    expect(prompt).toContain("do not describe internal mechanics");
    expect(prompt).not.toContain("## Live support request tickets");
    expect(prompt).toContain('OFFER: {"kind":"support","requestKind":"<question, part or fault>","summary":"<one short line>","description":"<the problem>"}');
    expect(prompt).toContain('OFFER: {"kind":"reply","issueKey":"DS-NN","body":');
    expect(prompt).toContain('OFFER: {"kind":"resolve","issueKey":"DS-NN","comment":"<optional closing comment>"}');
    expect(prompt).toContain("one short line in the requester's own words");
    expect(prompt).toContain("never include the surrounding conversation, other people's messages");
    expect(prompt).toContain("never sent to Jira");
    expect(prompt).toContain('Do not ask "Shall I" yourself');
    expect(prompt).toContain("add no marker");
  });

  it("offers a closing comment on resolve only in the requester's words, with its command form", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "DS" });
    expect(prompt).toContain("`@Wire Team Bot resolve DS-NN: <comment>` adds a closing comment to it first");
    expect(prompt).toContain('For resolve, add "comment" only when the requester asks to close or resolve the request with a note or comment');
    expect(prompt).toContain("only the text the requester wants added, in their own words");
    expect(prompt).toContain('Never invent a comment; otherwise leave "comment" out.');
  });

  it("has no action-to-Jira commands or old offer kinds", () => {
    for (const prompt of [integrationsPrompt({ jiraProjectKey: "DS" }), integrationsPrompt({ jiraProjectKey: "DS", jiraShareWithModel: true })]) {
      expect(prompt).not.toContain("ACT-NNNN");
      expect(prompt).not.toContain("to jira`");
      expect(prompt).not.toContain('"kind":"raise"');
      expect(prompt).not.toContain('"kind":"close"');
      expect(prompt).not.toContain("actionId");
      expect(prompt).not.toContain("Linked Jira tickets");
    }
  });

  it("describes the live section instead of the no-content line when sharing is on", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "DS", jiraShareWithModel: true });
    expect(prompt).not.toContain("you have no ticket content");
    expect(prompt).toContain('A "## Live support request tickets" section, when present, holds the live status, SLAs and latest service-desk replies');
    expect(prompt).toContain("cite the ticket key");
    expect(prompt).toContain("Say nothing about a ticket beyond what that section states");
    expect(prompt).toContain("give the status command");
    expect(prompt).toContain("never guess a ticket's status");
    expect(prompt).toContain('A "## Support requests" section');
    expect(prompt).toContain('OFFER: {"kind":"resolve","issueKey":"DS-NN","comment":"<optional closing comment>"}');
  });

  it("explains the three request kinds and the part essentials, which are never invented", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "DS" });
    expect(prompt).toContain('"question" for a question to the service desk, "part" for an order of a replacement part, and "fault" for a fault, breakdown, damage, or a service or maintenance need. When unsure, use "fault".');
    expect(prompt).toContain('"part":{"vehicle":"<fleet or chassis number>","part":"<part name or number>","quantity":"<how many>","deliverTo":"<delivery location>"}');
    expect(prompt).toContain("Take each value only from the requester's own messages, in their words; never invent, guess or infer one.");
    expect(prompt).toContain("Leave out every essential the requester has not given; the system asks for the missing ones, so do not ask for them yourself.");
    expect(prompt).toContain("For a part order, keep the essentials already given and add those the message supplies.");
    expect(prompt).toContain("to ask the service desk a question, to order a replacement part,");
    expect(prompt).toContain("key, summary, kind, requester and last known status");
  });

  it("describes the desk with the configured service scope, and keeps the generic wording without it", () => {
    const scope = "questions about the truck, faults, breakdowns, damage, service and maintenance, and replacement part orders";
    const prompt = integrationsPrompt({ jiraProjectKey: "DS", jiraServiceScope: `  ${scope}.\n` });
    expect(prompt).toContain(`Never say that it has no Jira integration or cannot work with Jira.\n- The service desk handles ${scope}.\n`);
    expect(integrationsPrompt({ jiraProjectKey: "DS" })).not.toContain("The service desk handles");
    expect(integrationsPrompt({ jiraServiceScope: scope })).toBe("");
  });

  it("uses the configured project key in the commands and offer format", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "OPS" });
    expect(prompt).toContain('"issueKey":"OPS-NN"');
    expect(prompt).toContain("`@Wire Team Bot resolve OPS-NN`");
  });
});

describe("OpenAIGeneralAnswerAdapter with support requests and offers", () => {
  it("renders stored requests and live tickets under their own sections and not under Related Context", async () => {
    const { llm, adapter } = setup("DS-4 is in progress.", { jiraProjectKey: "DS", jiraShareWithModel: true });
    await adapter.answer("Latest on DS-4?", [], [
      result("ACT-0010", "action", "ACT-0010 | Write the proposal"),
      result("DS-4", "support_request", "DS-4 | Summary: VPN drops | Requested by: Alice | Last known status: To do"),
      result("DS-4", "jira_ticket", "DS-4: VPN drops\nStatus: In progress"),
      result("E1", "entity", "Proposal relates to Acme"),
    ], [], undefined, 0.5);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(system).toContain("## Live support request tickets");
    expect(user).toContain("## Support requests\n- DS-4 | Summary: VPN drops | Requested by: Alice | Last known status: To do _(2026-09-25)_\n\n");
    expect(user).toContain("## Live support request tickets\n- DS-4: VPN drops\nStatus: In progress\n\n");
    const related = user.slice(user.indexOf("## Related Context"));
    expect(related).toContain("- Proposal relates to Acme");
    expect(related).not.toContain("VPN drops");
    expect(user.indexOf("## Relevant Actions")).toBeLessThan(user.indexOf("## Support requests"));
    expect(user.indexOf("## Support requests")).toBeLessThan(user.indexOf("## Live support request tickets"));
  });

  it("tells the model to revise a pending offer it is given, which appears under Related Context", async () => {
    const { llm, adapter } = setup("Updated.");
    const pending = 'Pending offer being amended (not confirmed, nothing was sent; the requester\'s message changes it): {"kind":"support","summary":"VPN drops","description":"My VPN drops."}';
    await adapter.answer("It started on Monday", [], [result("pending-offer", "summary", pending)], [], undefined, 0.5);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(system).toContain('A "Pending offer being amended" line under "## Related Context" is the requester\'s unconfirmed offer');
    expect(system).toContain("end with a revised marker of the same kind (for reply or resolve, the same issueKey)");
    expect(user).toContain(`## Related Context\n- ${pending}\n\n`);
  });

  it("omits both sections when there are no support request results", async () => {
    const { llm, adapter } = setup("Nothing yet.");
    await adapter.answer("Anything?", [], [result("E1", "entity", "Something")], [], undefined, 0.5);
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(user).not.toContain("## Support requests");
    expect(user).not.toContain("## Live support request tickets");
  });

  it("keeps a final marker line intact after text", async () => {
    const answer = `I can raise that with the service desk.\n${support}`;
    const { llm, adapter } = setup(answer);
    const returned = await adapter.answer("My VPN drops every ten minutes, can you raise it?", [], [], [], undefined, 0.5);
    expect(returned).toBe(answer);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops every ten minutes." });
  });

  it("keeps a reply marker whose body contains sentences and a question", async () => {
    const answer = 'Here is the reply.\nOFFER: {"kind":"reply","issueKey":"DS-4","body":"Thanks. Can you send the draft?"}';
    const { adapter } = setup(answer);
    const returned = await adapter.answer("Reply to DS-4", [], [], [], undefined, 0.5);
    expect(parseOfferMarker(returned)).toEqual({ text: "Here is the reply.", command: { kind: "reply", issueKey: "DS-4", body: "Thanks. Can you send the draft?" }, hadMarker: true });
  });

  it("strips a model-written offer question before the marker without losing the marker", async () => {
    const { llm, adapter } = setup(`That sounds like one for the service desk. Shall I raise it for you?\n${support}`);
    const returned = await adapter.answer("My VPN drops, please raise it", [], [], [], undefined, 0.5);
    expect(returned).toBe(`That sounds like one for the service desk.\n${support}`);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns the marker alone instead of retrying when the only text is an offer question", async () => {
    const { llm, adapter } = setup(`Shall I raise it with the service desk?\n${support}`);
    const returned = await adapter.answer("My VPN drops, please raise it", [], [], [], undefined, 0.5);
    expect(returned).toBe(support);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps the marker from the retry answer", async () => {
    const { llm, adapter } = setup(["Shall I check?", 'Here it is.\nOFFER: {"kind":"resolve","issueKey":"DS-6"}']);
    const returned = await adapter.answer("The VPN works again, close DS-6", [], [], [], undefined, 0.5);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(2);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "resolve", issueKey: "DS-6" });
  });
});
