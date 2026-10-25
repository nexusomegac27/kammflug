import { createFileRoute } from "@tanstack/react-router";
import { tileIntersectsRadius } from "@/game/observed";

const UPSTREAM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

export const Route = createFileRoute("/api/dem-tile/$z/$x/$y")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const z = Number(params.z);
        const x = Number(params.x);
        const y = Number(params.y);
        if (![z, x, y].every((n) => Number.isInteger(n))) {
          return new Response("bad tile", { status: 400 });
        }
        if (!tileIntersectsRadius(z, x, y)) {
          return new Response("outside observed radius", { status: 403 });
        }
        const upstream = await fetch(`${UPSTREAM}/${z}/${x}/${y}.png`);
        if (!upstream.ok) return new Response("upstream", { status: 502 });
        const source = upstream.headers.get("x-amz-meta-x-imagery-sources") ?? "";
        return new Response(await upstream.arrayBuffer(), {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
            "x-dem-source": source,
          },
        });
      },
    },
  },
});
