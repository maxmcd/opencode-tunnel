export function Welcome() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-white px-4 font-mono">
      <div className="text-2xl font-bold mb-4">OpenCode Tunnel</div>
      <p className="text-sm text-gray-500 mb-4">
        Connect to your OpenCode session anywhere.
      </p>
      <div className="w-full max-w-xl rounded-md border border-gray-300 bg-gray-100 shadow-sm">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-300">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          <span className="h-3 w-3 rounded-full bg-green-400" />
        </div>
        <pre className="px-4 py-6 text-sm text-gray-800 font-mono whitespace-pre-wrap">
          ${" "}
          <span className="font-bold text-purple-600">
            bunx opencode-tunnel
          </span>
          {"\n"}Starting OpenCode process and connecting to tunnel...{"\n"}
          OpenCode tunnel is live at: https://k2humhpx.phew.network
        </pre>
      </div>
      <p className="mt-4">
        <a
          className="underline text-sm text-purple-400"
          href="https://github.com/maxmcd/opencode-tunnel"
        >
          Source
        </a>
      </p>
      <p className="mt-4 text-xs text-gray-400">
        (not an official OpenCode project)
      </p>
    </main>
  );
}
