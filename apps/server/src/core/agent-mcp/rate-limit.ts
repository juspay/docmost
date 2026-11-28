import type Redis from 'ioredis';

export const TOOL_CALLS_PER_MINUTE = 120;

// Fixed one-minute window per token. False when the allowance is spent.
export async function takeToolCall(
  redis: Pick<Redis, 'incr' | 'expire'>,
  tokenId: string,
): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `agent-mcp:calls:${tokenId}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 90);
  return count <= TOOL_CALLS_PER_MINUTE;
}
