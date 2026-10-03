import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface ExpectedResponse {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  status?: number;
  query?: Record<string, string>;
}

// Register every observer before the action. A click completing does not mean
// its fetch, client-side redirect, or destination fetch has completed.
// Callers must still assert the resulting UI: a response is not a React commit.
export async function transition(
  page: Page,
  expected: { responses: ExpectedResponse[]; url?: string },
  action: () => Promise<unknown>,
): Promise<void> {
  await test.step("Complete " + (expected.url ?? expected.responses.map((item) => item.path).join(", ")), async () => {
    const responses = expected.responses.map(async (item) => {
      const response = await page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return url.origin === "http://localhost:9000"
          && url.pathname === item.path
          && candidate.request().method() === item.method
          && Object.entries(item.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value);
      });
      expect(response.status(), item.method + " " + item.path).toBe(item.status ?? 200);
      expect(await response.finished(), "Response must finish: " + item.path).toBeNull();
    });
    await Promise.all([
      ...responses,
      ...(expected.url ? [page.waitForURL(expected.url)] : []),
      action(),
    ]);
  });
}
