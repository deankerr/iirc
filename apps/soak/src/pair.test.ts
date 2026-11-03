import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CheckPairText, SendPairText } from "./pair.ts";

const sendPair = Schema.decodeUnknownSync(SendPairText);
const checkPair = Schema.decodeUnknownSync(CheckPairText);

const refusesSend = (text: string) => Option.isNone(Schema.decodeOption(SendPairText)(text));

const refusesCheck = (text: string) => Option.isNone(Schema.decodeOption(CheckPairText)(text));

describe("PROOF-5: a pair argument", () => {
  it("PROOF-5: reads <networkId>=<target> for send", () => {
    expect(sendPair("floor=#soak")).toStrictEqual({ network: "floor", target: "#soak" });
  });

  it("PROOF-5: takes everything after the first = as the Target, because a Target may hold one", () => {
    expect(sendPair("floor=#a=b")).toStrictEqual({ network: "floor", target: "#a=b" });
  });

  it("PROOF-5: reads <sender>:<receiver>=<target> for check, a Target holding : included", () => {
    expect(checkPair("soak-a:soak-b=#chan:one")).toStrictEqual({
      receiver: "soak-b",
      sender: "soak-a",
      target: "#chan:one",
    });
  });

  it.each(["floor", "=#soak", "floor=", "Floor=#soak", "floor=#so ak", "floor=#a,#b", "a b=#soak"])(
    "PROOF-5: refuses the send pair %j",
    (text) => {
      expect(refusesSend(text)).toBeTruthy();
    }
  );

  it.each([
    "floor=#soak",
    "floor:=#soak",
    ":floor=#soak",
    "floor:floor",
    "a:b:c=#soak",
    "floor:floor=",
  ])("PROOF-5: refuses the check pair %j", (text) => {
    expect(refusesCheck(text)).toBeTruthy();
  });

  it("PROOF-5: writes a pair back as it was typed", () => {
    expect(Schema.encodeSync(CheckPairText)({ receiver: "b", sender: "a", target: "#t" })).toBe(
      "a:b=#t"
    );
  });
});
