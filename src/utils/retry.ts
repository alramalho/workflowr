export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, delays = [4000, 8000, 16000] } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) console.log(`[retry] Recovered on attempt ${attempt + 1}`);
      return result;
    } catch (error) {
      if (attempt === retries) throw error;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      console.warn(`[retry] Attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`, (error as Error).message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
