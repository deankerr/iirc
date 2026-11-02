import { describe, expect, it } from "vitest";

import { fullBucket, nextSendAt, takeToken } from "./flood.ts";
import type { FloodLimit, TokenBucket } from "./flood.ts";

const limit: FloodLimit = { burst: 5, intervalMillis: 2000 };
const start = 1_000_000;

const spend = (bucket: TokenBucket, now: number) => {
  const taken = takeToken(bucket, limit, now);

  if (taken === undefined) {
    throw new Error(`No token at ${now}`);
  }

  return taken;
};

const afterBurst = (now: number) => {
  let bucket = fullBucket;

  for (let sent = 0; sent < limit.burst; sent += 1) {
    bucket = spend(bucket, now);
  }

  return bucket;
};

describe("the token bucket", () => {
  it("SEND-2: lets a full burst go at once, and no more", () => {
    const bucket = afterBurst(start);

    expect(takeToken(bucket, limit, start)).toBeUndefined();
  });

  it("SEND-2: says now while a token is free", () => {
    expect(nextSendAt(fullBucket, limit, start)).toBe(start);
  });

  it("SEND-2: says when the next token is free once the burst is spent", () => {
    expect(nextSendAt(afterBurst(start), limit, start)).toBe(start + 2000);
  });

  it("SEND-2: holds one Line back until exactly the moment it said", () => {
    const bucket = afterBurst(start);

    expect(takeToken(bucket, limit, start + 1999)).toBeUndefined();
    expect(takeToken(bucket, limit, start + 2000)).toBeDefined();
  });

  it("SEND-2: settles at one Line every 2 seconds under pressure", () => {
    let bucket = afterBurst(start);
    let now = start;
    const times: number[] = [];

    for (let round = 0; round < 4; round += 1) {
      now = nextSendAt(bucket, limit, now);
      times.push(now);
      bucket = spend(bucket, now);
    }

    expect(times).toStrictEqual([start + 2000, start + 4000, start + 6000, start + 8000]);
  });

  it("SEND-2: refills to the burst and no further", () => {
    let bucket = afterBurst(start);
    const later = start + 1_000_000;

    for (let sent = 0; sent < limit.burst; sent += 1) {
      bucket = spend(bucket, later);
    }

    expect(takeToken(bucket, limit, later)).toBeUndefined();
  });

  it("SEND-2: returns a token per interval, not all at once", () => {
    const bucket = spend(afterBurst(start), start + 2000);

    expect(nextSendAt(bucket, limit, start + 2000)).toBe(start + 4000);
  });

  it("SEND-2: an Owner can tune it", () => {
    const tuned: FloodLimit = { burst: 1, intervalMillis: 100 };
    const bucket = takeToken(fullBucket, tuned, start);

    expect(bucket && nextSendAt(bucket, tuned, start)).toBe(start + 100);
  });

  it("LOG-8: a clock set back cannot stall Lines for as long as it moved", () => {
    const bucket = afterBurst(start);
    const earlier = start - 3_600_000;

    expect(nextSendAt(bucket, limit, earlier)).toBeLessThanOrEqual(earlier + 2000);
  });

  it("leaves the bucket it was given as it was", () => {
    const bucket = spend(fullBucket, start);

    spend(bucket, start);

    expect(nextSendAt(bucket, limit, start)).toBe(start);
    expect(bucket).toStrictEqual({ fullAt: start + 2000 });
  });
});
