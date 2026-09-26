import { describe, it, expect, vi } from "vitest";
import { OfferSupportFromConversation, PASSIVE_CONFIDENCE_MIN } from "../../src/application/usecases/jira/OfferSupportFromConversation";
import type { OfferSupportInput } from "../../src/application/usecases/jira/OfferSupportFromConversation";
import { GetIssueStatus } from "../../src/application/usecases/jira/GetIssueStatus";
import { formatIssueStatus } from "../../src/application/usecases/jira/formatIssue";
import { OFFER_DESCRIPTION_MAX, OFFER_TTL_MS, formatSupportQuestion } from "../../src/application/services/offers";
import { SUPPORT_SUMMARY_MAX } from "../../src/domain/entities/SupportRequest";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { SupportDraft } from "../../src/application/ports/SupportTriagePort";
import { alice, convId, loggedText, makeAudit, makeLogger, makeRequest, makeRequests, makeSnapshot, makeTracker, makeWire } from "./supportRequestFakes";

const MESSAGE = "PRIVATE_MESSAGE_MARKER the printer on floor 3 jams on every job";
const DRAFT: SupportDraft = {
  summary: "Printer on floor 3 jams on every job",
  description: "The printer on floor 3 jams on every job.",
  duplicateOf: null,
};

function input(overrides: Partial<OfferSupportInput> = {}): OfferSupportInput {
  return {
    text: MESSAGE,
    messageId: "msg-9",
    conversationId: convId,
    senderId: alice,
    senderName: "Alice",
    categories: ["service_request"],
    confidence: 0.9,
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

function setup(records: SupportRequest[] = [makeRequest()], draft: SupportDraft | null = DRAFT, statusKey: string | null = null) {
  const requests = makeRequests(records);
  const triage = {
    draftRequest: vi.fn().mockResolvedValue(draft),
    matchStatusQuestion: vi.fn().mockResolvedValue(statusKey),
  };
  const getIssueStatus = { projectKey: "DS", execute: vi.fn().mockResolvedValue(null) };
  const offers = {
    put: vi.fn(), take: vi.fn(), has: vi.fn().mockReturnValue(false), clearConversation: vi.fn(),
    drop: vi.fn(), recentlyDropped: vi.fn(),
  };
  const { wire, sent } = makeWire();
  const logger = makeLogger();
  const useCase = new OfferSupportFromConversation(requests, triage, getIssueStatus as unknown as GetIssueStatus, offers, wire, logger);
  return { requests, triage, getIssueStatus, offers, wire, sent, logger, useCase };
}

describe("formatSupportQuestion", () => {
  it("quotes the summary in bold and the description line by line", () => {
    expect(formatSupportQuestion("VPN drops", "It drops every ten minutes.\n\nSince Monday."))
      .toBe("Shall I raise this with the service desk?\n> **VPN drops**\n> It drops every ten minutes.\n> Since Monday.\n\n(yes or no)?");
  });

  it("leaves out a description that only repeats the summary", () => {
    expect(formatSupportQuestion("VPN drops", "  vpn   drops "))
      .toBe("Shall I raise this with the service desk?\n> **VPN drops**\n\n(yes or no)?");
  });
});

describe("OfferSupportFromConversation", () => {
  describe("gate", () => {
    it("does nothing below the confidence threshold", async () => {
      const { requests, triage, sent, useCase } = setup();

      await useCase.execute(input({ confidence: PASSIVE_CONFIDENCE_MIN - 0.01 }));

      expect(requests.listByConversation).not.toHaveBeenCalled();
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("acts at exactly the threshold", async () => {
      const { sent, useCase } = setup();

      await useCase.execute(input({ confidence: PASSIVE_CONFIDENCE_MIN }));

      expect(sent).toHaveLength(1);
    });

    it("does nothing without a service-desk category", async () => {
      const { triage, sent, useCase } = setup();

      await useCase.execute(input({ categories: ["blocker", "question"] }));

      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(triage.matchStatusQuestion).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });
  });

  describe("service_request", () => {
    it("sends the code-written question as a native reply, then stores the offer for the speaker", async () => {
      const { triage, offers, wire, sent, useCase } = setup();
      const before = Date.now();

      await useCase.execute(input());

      expect(triage.draftRequest).toHaveBeenCalledWith(MESSAGE, [{ key: "DS-6", summary: "VPN drops every ten minutes" }]);
      expect(sent).toEqual([formatSupportQuestion(DRAFT.summary, DRAFT.description)]);
      expect(sent[0]).toBe("Shall I raise this with the service desk?\n> **Printer on floor 3 jams on every job**\n> The printer on floor 3 jams on every job.\n\n(yes or no)?");
      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
      expect(offers.put).toHaveBeenCalledTimes(1);
      const offer = offers.put.mock.calls[0]![0];
      expect(offer).toMatchObject({
        command: { kind: "support", summary: DRAFT.summary, description: DRAFT.description },
        conversationId: convId,
        requesterId: alice,
      });
      expect(offer.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBe(OFFER_TTL_MS);
      expect(wire.sendPlainText.mock.invocationCallOrder[0]).toBeLessThan(offers.put.mock.invocationCallOrder[0]!);
    });

    it("collapses whitespace in the summary and trims the description", async () => {
      const { offers, sent, useCase } = setup(undefined, { summary: "  Printer\n jams  ", description: "\n Printer jams on every job. \n", duplicateOf: null });

      await useCase.execute(input());

      expect(offers.put.mock.calls[0]![0].command).toEqual({ kind: "support", summary: "Printer jams", description: "Printer jams on every job." });
      expect(sent[0]).toContain("> **Printer jams**\n> Printer jams on every job.");
    });

    it("shows only the summary when the description repeats it", async () => {
      const { sent, useCase } = setup(undefined, { summary: "Printer jams", description: "printer jams", duplicateOf: null });

      await useCase.execute(input());

      expect(sent).toEqual(["Shall I raise this with the service desk?\n> **Printer jams**\n\n(yes or no)?"]);
    });

    it("passes only open requests of this conversation in the tracker's project, at most 20", async () => {
      const many = Array.from({ length: 25 }, (_, i) => makeRequest({ key: `DS-${100 + i}`, summary: `Problem ${i}` }));
      const records = [
        makeRequest({ key: "DS-1", statusCategory: "done" }),
        makeRequest({ key: "DS-2", conversationId: { id: "conv-2", domain: "wire.com" } }),
        makeRequest({ key: "DS-3", conversationId: { id: "conv-1", domain: "other.example" } }),
        makeRequest({ key: "DS-4", deleted: true }),
        makeRequest({ key: "OPS-5" }),
        makeRequest({ key: "DS-6", statusCategory: "in_progress" }),
        ...many,
      ];
      const { requests, triage, useCase } = setup(records);

      await useCase.execute(input());

      expect(requests.listByConversation).toHaveBeenCalledWith(convId, { openOnly: true, limit: 20 });
      const open = triage.draftRequest.mock.calls[0]![1] as Array<{ key: string; summary: string }>;
      expect(open).toHaveLength(20);
      expect(open[0]).toEqual({ key: "DS-6", summary: "VPN drops every ten minutes" });
      for (const excluded of ["DS-1", "DS-2", "DS-3", "DS-4", "OPS-5"]) expect(open.map((r) => r.key)).not.toContain(excluded);
      expect(Object.keys(open[0]!)).toEqual(["key", "summary"]);
    });

    it("stays silent when the model finds no service-desk problem", async () => {
      const { offers, sent, useCase } = setup(undefined, null);

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("stays silent when an open request of this conversation already covers the problem", async () => {
      const { offers, sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "ds-6" });

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("still offers when the named duplicate is not an open request of this conversation", async () => {
      const { sent, useCase } = setup(undefined, { ...DRAFT, duplicateOf: "DS-99" });

      await useCase.execute(input());

      expect(sent).toHaveLength(1);
    });

    it.each<[string, SupportDraft]>([
      ["an empty summary", { ...DRAFT, summary: "  " }],
      ["a summary over the limit", { ...DRAFT, summary: "x".repeat(SUPPORT_SUMMARY_MAX + 1) }],
      ["an empty description", { ...DRAFT, description: " \n " }],
      ["a description over the offer limit", { ...DRAFT, description: "y".repeat(OFFER_DESCRIPTION_MAX + 1) }],
    ])("drops a draft with %s", async (_label, draft) => {
      const { offers, sent, useCase } = setup(undefined, draft);

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("accepts a draft exactly at the bounds", async () => {
      const draft = { summary: "x".repeat(SUPPORT_SUMMARY_MAX), description: "y".repeat(OFFER_DESCRIPTION_MAX), duplicateOf: null };
      const { offers, useCase } = setup(undefined, draft);

      await useCase.execute(input());

      expect(offers.put).toHaveBeenCalledTimes(1);
    });

    it("never offers while the speaker has a live offer", async () => {
      const { triage, offers, sent, useCase } = setup();
      offers.has.mockReturnValue(true);

      await useCase.execute(input());

      expect(offers.has).toHaveBeenCalledWith(convId, alice);
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not replace an offer made while the draft was being written", async () => {
      const { offers, sent, useCase } = setup();
      offers.has.mockReturnValueOnce(false).mockReturnValue(true);

      await useCase.execute(input());

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("sends and stores nothing when the job was cancelled during the draft", async () => {
      const controller = new AbortController();
      const { triage, offers, sent, useCase } = setup();
      triage.draftRequest.mockImplementation(async () => { controller.abort(); return DRAFT; });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toEqual([]);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the offer when the channel is paused while the question is being sent", async () => {
      const controller = new AbortController();
      const { wire, offers, sent, useCase } = setup();
      wire.sendPlainText.mockImplementation(async (_conv: unknown, text: string) => { sent.push(text); controller.abort(); });

      await useCase.execute(input({ signal: controller.signal }));

      expect(sent).toHaveLength(1);
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("does not store the offer when sending the question failed", async () => {
      const { wire, offers, logger, useCase } = setup();
      wire.sendPlainText.mockRejectedValue(new TypeError("socket closed"));

      await expect(useCase.execute(input())).resolves.toBeUndefined();

      expect(offers.put).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "TypeError" });
    });

    it("logs a model failure by error name only and stays silent", async () => {
      const { triage, sent, logger, useCase } = setup();
      triage.draftRequest.mockRejectedValue(new RangeError(`bad ${MESSAGE}`));

      await expect(useCase.execute(input())).resolves.toBeUndefined();

      expect(sent).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "RangeError" });
      expect(loggedText(logger)).not.toContain("PRIVATE_MESSAGE_MARKER");
    });

    it("stays silent when the open requests cannot be read", async () => {
      const { requests, triage, sent, logger, useCase } = setup();
      requests.listByConversation.mockRejectedValue(new Error("db down"));

      await useCase.execute(input());

      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "Error" });
    });

    it("never logs the message, the draft or the summaries", async () => {
      const records = [makeRequest({ summary: "PRIVATE_SUMMARY_MARKER" })];
      const draft = { summary: "PRIVATE_DRAFT_MARKER", description: "PRIVATE_DESCRIPTION_MARKER", duplicateOf: null };
      for (const d of [draft, { ...draft, duplicateOf: "DS-6" }, { ...draft, summary: "z".repeat(500) }]) {
        const { logger, useCase } = setup(records, d);
        await useCase.execute(input());
        const logged = loggedText(logger);
        for (const marker of ["PRIVATE_MESSAGE_MARKER", "PRIVATE_SUMMARY_MARKER", "PRIVATE_DRAFT_MARKER", "PRIVATE_DESCRIPTION_MARKER"]) {
          expect(logged).not.toContain(marker);
        }
      }
    });
  });

  describe("request_status", () => {
    it("answers through GetIssueStatus as a native reply when the question matches an open request", async () => {
      const { triage, getIssueStatus, offers, sent, useCase } = setup(undefined, DRAFT, "ds-6");

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(triage.matchStatusQuestion).toHaveBeenCalledWith(MESSAGE, [{ key: "DS-6", summary: "VPN drops every ten minutes" }]);
      expect(getIssueStatus.execute).toHaveBeenCalledWith({
        reference: "DS-6", conversationId: convId, timezone: "Europe/Berlin", replyToMessageId: "msg-9",
      });
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(offers.put).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("stays silent when the question matches no open request", async () => {
      const { getIssueStatus, sent, useCase } = setup(undefined, DRAFT, null);

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("ignores a key that is not an open request of this conversation", async () => {
      const records = [makeRequest(), makeRequest({ key: "DS-7", statusCategory: "done" })];
      for (const key of ["DS-7", "DS-99", "OPS-6"]) {
        const { getIssueStatus, sent, useCase } = setup(records, DRAFT, key);
        await useCase.execute(input({ categories: ["request_status"] }));
        expect(getIssueStatus.execute).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
      }
    });

    it("does not ask the model when the conversation has no open requests", async () => {
      const { triage, getIssueStatus, useCase } = setup([], DRAFT, "DS-6");

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(triage.matchStatusQuestion).not.toHaveBeenCalled();
      expect(getIssueStatus.execute).not.toHaveBeenCalled();
    });

    it("does not answer when the job was cancelled during the match", async () => {
      const controller = new AbortController();
      const { triage, getIssueStatus, useCase } = setup(undefined, DRAFT, "DS-6");
      triage.matchStatusQuestion.mockImplementation(async () => { controller.abort(); return "DS-6"; });

      await useCase.execute(input({ categories: ["request_status"], signal: controller.signal }));

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
    });

    it("logs a model failure by error name only and stays silent", async () => {
      const { triage, getIssueStatus, logger, useCase } = setup();
      triage.matchStatusQuestion.mockRejectedValue(new SyntaxError("bad"));

      await expect(useCase.execute(input({ categories: ["request_status"] }))).resolves.toBeUndefined();

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { err: "SyntaxError" });
    });

    it("replies with the live status through the real GetIssueStatus", async () => {
      const records = [makeRequest()];
      const requests = makeRequests(records);
      const tracker = makeTracker();
      const { wire, sent } = makeWire();
      const getIssueStatus = new GetIssueStatus(requests, tracker, wire, makeAudit(), makeLogger());
      const triage = { draftRequest: vi.fn(), matchStatusQuestion: vi.fn().mockResolvedValue("DS-6") };
      const offers = { put: vi.fn(), take: vi.fn(), has: vi.fn(), clearConversation: vi.fn(), drop: vi.fn(), recentlyDropped: vi.fn() };
      const useCase = new OfferSupportFromConversation(requests, triage, getIssueStatus, offers, wire, makeLogger());

      await useCase.execute(input({ categories: ["request_status"] }));

      expect(sent).toEqual([formatIssueStatus(makeSnapshot(), "No replies from the service desk yet.")]);
      expect(wire.sendPlainText).toHaveBeenCalledWith(convId, sent[0], { replyToMessageId: "msg-9" });
      expect(tracker.createIssue).not.toHaveBeenCalled();
    });
  });

  describe("both categories", () => {
    it("prefers the status answer when an open request matches", async () => {
      const { triage, getIssueStatus, offers, useCase } = setup(undefined, DRAFT, "DS-6");

      await useCase.execute(input({ categories: ["service_request", "request_status"] }));

      expect(getIssueStatus.execute).toHaveBeenCalledTimes(1);
      expect(triage.draftRequest).not.toHaveBeenCalled();
      expect(offers.put).not.toHaveBeenCalled();
    });

    it("offers when no open request matches", async () => {
      const { getIssueStatus, offers, sent, useCase } = setup(undefined, DRAFT, null);

      await useCase.execute(input({ categories: ["request_status", "service_request"] }));

      expect(getIssueStatus.execute).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(offers.put).toHaveBeenCalledTimes(1);
    });
  });
});
