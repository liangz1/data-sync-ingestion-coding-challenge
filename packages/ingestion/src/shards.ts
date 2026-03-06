export type TimeShard = {
  shardId: string;
  sinceMs: number;
  untilMs: number;
};

export function buildTimeShards(
  sinceMs: number,
  untilMs: number,
  shardSizeMs: number
): TimeShard[] {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    throw new Error("sinceMs and untilMs must be valid numbers");
  }
  if (!Number.isFinite(shardSizeMs) || shardSizeMs <= 0) {
    throw new Error("shardSizeMs must be a positive number");
  }
  if (sinceMs >= untilMs) {
    throw new Error("sinceMs must be less than untilMs");
  }

  const shards: TimeShard[] = [];
  let cursor = sinceMs;
  let i = 0;

  while (cursor < untilMs) {
    const next = Math.min(cursor + shardSizeMs, untilMs);
    shards.push({
      shardId: `shard-${i}`,
      sinceMs: cursor,
      untilMs: next,
    });
    cursor = next;
    i += 1;
  }

  return shards;
}
