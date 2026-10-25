import { createFileRoute } from "@tanstack/react-router";
import { Kammflug } from "@/components/kammflug";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Kammflug />;
}
