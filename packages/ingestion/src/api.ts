import type { EventsResponse } from "./types";

export function buildEventsUrl(baseUrl: string, limit: number, cursor?: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/events`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

export async function retrievePage(
  baseUrl: string,
  limit: number,
  cursor?: string
): Promise<EventsResponse> {
  const url = buildEventsUrl(baseUrl, limit, cursor);

  console.log(`[ingestion] GET ${url}`);

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${body}`);
  }

  const json = await res.json();
  return json as EventsResponse;
}
