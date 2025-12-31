import type { Route } from "./+types/home";
import { Welcome } from "../welcome/welcome";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "OpenCode Tunnel" },
    {
      name: "description",
      content: "Connect to your OpenCode session anywhere",
    },
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  return { message: "hello" };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <div className="text-sm mb-4 text-center italic fixed top-4 left-1/2 -translate-x-1/2">
        <a href="/">😮‍💨.network</a>
      </div>
      <Welcome />
    </>
  );
}
