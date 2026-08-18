import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home() {
  const host = (await headers()).get("host") ?? "";

  if (host.startsWith("[::1]")) {
    const port = host.match(/\]:(\d+)$/)?.[1];
    redirect(`http://localhost${port ? `:${port}` : ""}/app`);
  }

  redirect("/app");
}
