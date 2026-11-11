import { apiCtx, route } from "@/lib/server/auth";
import { styleSamples } from "@/lib/server/styleSamples";

// What each picture style looks like: its example's address once it's drawn (asking starts drawing those missing).
export const GET = route(async () => {
  await apiCtx();
  return Response.json(styleSamples(), { headers: { "Cache-Control": "no-store" } });
});
