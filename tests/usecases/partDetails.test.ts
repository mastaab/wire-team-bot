import { describe, it, expect } from "vitest";
import { statedPartDetails } from "../../src/application/services/partDetails";

describe("statedPartDetails", () => {
  it("drops a quantity the driver did not state, such as 1 for \"a new mirror\"", () => {
    expect(statedPartDetails({ vehicle: "truck 7", part: "left mirror", quantity: "1" }, "we need a new left mirror for truck 7"))
      .toEqual({ vehicle: "truck 7", part: "left mirror" });
  });

  it.each([
    ["two, deliver to depot north", "2"],
    ["two, deliver to depot north", "two"],
    ["3 please", "3"],
    ["a pair of wiper blades", "2"],
    ["zwei Stück, bitte", "2"],
  ])("keeps a quantity stated in %j as %j", (message, quantity) => {
    expect(statedPartDetails({ quantity }, message)).toEqual({ quantity });
  });

  it("does not take the vehicle's number for a quantity", () => {
    expect(statedPartDetails({ vehicle: "truck 7", quantity: "7" }, "a new mirror for truck 7")).toEqual({ vehicle: "truck 7" });
  });

  it("drops a quantity that is not a number, and a location the message does not mention", () => {
    expect(statedPartDetails({ quantity: "some", deliverTo: "Hamburg" }, "some mirrors to depot north")).toEqual({});
  });

  it("keeps vehicle, part and delivery location that share a word with the message", () => {
    expect(statedPartDetails({ vehicle: "truck 12", part: "brake pads", deliverTo: "Depot North" }, "brake pads for truck 12 to the north depot"))
      .toEqual({ vehicle: "truck 12", part: "brake pads", deliverTo: "Depot North" });
  });
});
