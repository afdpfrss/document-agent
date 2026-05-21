import { ChatWindow } from "@/components/ChatWindow";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-indigo-900 text-white flex items-center justify-center font-bold text-sm">
              D
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900 leading-tight">
                社内ドキュメント検索
              </h1>
              <p className="text-xs text-slate-500 leading-tight">
                Powered by Gemini Flash
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        <ChatWindow />
      </main>
    </div>
  );
}
